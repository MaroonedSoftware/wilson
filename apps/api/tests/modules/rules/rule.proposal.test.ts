import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { RuleProposalJob } from '#modules/jobs/rule.proposal.job.js';
import { RuleJudgeEngine, RuleJudgeEngineMap, type RuleJudgeCall, type RuleJudgeReply } from '#modules/rules/rule.judge.engine.js';
import { RuleProposalDrafter } from '#modules/rules/rule.proposal.drafter.js';
import { RULE_PROPOSAL_LIFETIME, RuleProposalRepository } from '#modules/rules/rule.proposal.repository.js';
import { RuleProposalService } from '#modules/rules/rule.proposal.service.js';
import { PostgresRuleStore } from '#modules/rules/rule.store.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import type { ReviewFinding } from '#modules/stages/stage.result.js';
import { defaultSettings } from '#tests/support/fake.settings.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

class ScriptedEngine extends RuleJudgeEngine {
    readonly calls: RuleJudgeCall[] = [];
    constructor(private readonly answer: () => RuleJudgeReply) {
        super();
    }
    async ask(call: RuleJudgeCall): Promise<RuleJudgeReply> {
        this.calls.push(call);
        return this.answer();
    }
}

const blockers: ReviewFinding[] = [
    { severity: 'blocker', kind: 'defect', file: 'src/a.ts', line: 2, problem: 'It logs a token.', suggestion: 'Do not.' },
];
const drafted: RuleJudgeReply = {
    text: JSON.stringify({ propose: true, statement: 'Never log a token.', paths: ['src/**'], reason: 'It came up in the auth code.' }),
    usage: { inputTokens: 300, outputTokens: 40 },
};

describe('proposing a rule from a kickback', () => {
    let config: StaticBoardConfig;
    let proposals: RuleProposalRepository;
    let rules: PostgresRuleStore;
    let events: EventLog;
    let service: RuleProposalService;

    beforeEach(() => {
        config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        proposals = new RuleProposalRepository(config, db);
        rules = new PostgresRuleStore(config, db);
        events = new EventLog(db, silentLogger as never);
        service = new RuleProposalService(proposals, rules);
    });

    const jobWith = (engine: RuleJudgeEngine | undefined, settings = defaultSettings) => {
        const engines = new RuleJudgeEngineMap();
        if (engine) engines.set('cli', engine);
        return new RuleProposalJob(proposals, new RuleProposalDrafter(rules, settings, engines), config, events, settings, silentLogger as never);
    };
    const run = (job: RuleProposalJob, cardId = '0001') => job.run({ cardId, project: config.project, blockers });
    const events0001 = async () => (await events.tail(config.project, '0001')).filter(row => row.type === 'rule.proposed');
    const pendingOne = async () => {
        await run(jobWith(new ScriptedEngine(() => drafted)));
        return (await service.list())[0]!;
    };

    it('drafts one that waits on a person, charging the card for it', async () => {
        const engine = new ScriptedEngine(() => drafted);

        await run(jobWith(engine));

        expect(await service.list()).toEqual([
            expect.objectContaining({ cardId: '0001', statement: 'Never log a token.', paths: ['src/**'], reason: 'It came up in the auth code.' }),
        ]);
        expect(engine.calls[0]?.prompt).toContain('It logs a token.');
        expect(await rules.list()).toEqual([]);
        expect((await events0001())[0]?.payload).toMatchObject({ statement: 'Never log a token.', usage: { inputTokens: 300 } });
        expect(await events.budgetedInputTokens(config.project, '0001')).toBe(300);
    });

    it('gives a card one look, however many times it is sent back', async () => {
        const engine = new ScriptedEngine(() => drafted);
        const job = jobWith(engine);

        await run(job);
        await run(job);

        expect(engine.calls).toHaveLength(1);
        expect(await service.list()).toHaveLength(1);
    });

    it('lets two cards have one each', async () => {
        const job = jobWith(new ScriptedEngine(() => drafted));

        await run(job, '0001');
        await run(job, '0002');

        expect(await service.list()).toHaveLength(2);
    });

    it.each([
        ['the model finding nothing worth a rule', () => ({ text: '{"propose":false,"reason":"A one-off."}' }), 'A one-off.'],
        ['a reply that is not a draft', () => ({ text: 'hmm' }), 'the model did not reply with a draft'],
        [
            'a draft that would not make a rule',
            () => ({ text: '{"propose":true,"statement":"x","paths":[]}' }),
            expect.stringContaining('would not make a rule'),
        ],
        [
            'an engine that fails',
            () => {
                throw new Error('engine down');
            },
            'engine down',
        ],
    ])('leaves nothing waiting after %s, and spends no second look', async (_name, answer, reason) => {
        const engine = new ScriptedEngine(answer);
        const job = jobWith(engine);

        await run(job);
        await run(job);

        expect(await service.list()).toEqual([]);
        expect(engine.calls).toHaveLength(1);
        expect((await events0001())[0]?.payload).toMatchObject({ reason });
    });

    it('makes no call past the daily ceiling, and leaves the look for later', async () => {
        const engine = new ScriptedEngine(() => drafted);
        const settings = {
            get: async (definition: { key: string; defaultValue: unknown }) =>
                definition.key === DAILY_OUTPUT_TOKEN_CEILING.key ? 1 : definition.defaultValue,
        } as never;
        await events.append({
            project: config.project,
            cardId: '0009',
            stage: 'review',
            type: 'stage.passed',
            payload: { usage: { outputTokens: 5 } },
        });

        await run(jobWith(engine, settings));
        expect(engine.calls).toEqual([]);

        await run(jobWith(engine));
        expect(engine.calls).toHaveLength(1);
    });

    it('asks a model that already knows the rules there are', async () => {
        await rules.create('existing', { statement: 'Existing words', paths: ['**'], severity: 'blocker' }, 'x');
        const engine = new ScriptedEngine(() => drafted);

        await run(jobWith(engine));

        expect(engine.calls[0]?.prompt).toContain('existing: Existing words');
    });

    describe('a person deciding', () => {
        it('makes it a rule on accept, with their name and changes', async () => {
            const { id } = await pendingOne();

            const rule = await service.accept(id, { id: 'no-token-logs', severity: 'concern' });

            expect(rule).toMatchObject({ id: 'no-token-logs', statement: 'Never log a token.', paths: ['src/**'], severity: 'concern' });
            expect(await service.list()).toEqual([]);
            const row = await db.selectFrom('wilson.ruleProposals').selectAll().where('project', '=', config.project).executeTakeFirstOrThrow();
            expect(row).toMatchObject({ status: 'accepted', rule: 'no-token-logs' });
        });

        it('takes a decision at most once, however they race', async () => {
            const { id } = await pendingOne();

            const results = await Promise.allSettled([service.accept(id, { id: 'a' }), service.accept(id, { id: 'b' }), service.decline(id)]);

            expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
            expect(results.filter(result => result.status === 'rejected')).toEqual(
                expect.arrayContaining([expect.objectContaining({ reason: expect.objectContaining({ statusCode: 409 }) })]),
            );
            expect((await rules.list()).length).toBeLessThanOrEqual(1);
        });

        it('puts it back when the rule cannot be written', async () => {
            await rules.create('taken', { statement: 's', paths: ['**'], severity: 'blocker' }, 'x');
            const { id } = await pendingOne();

            await expect(service.accept(id, { id: 'taken' })).rejects.toMatchObject({ statusCode: 409 });
            await expect(service.accept(id, { id: 'Not Valid' })).rejects.toMatchObject({ statusCode: 400 });

            expect(await service.list()).toHaveLength(1);
            await expect(service.accept(id, { id: 'free' })).resolves.toMatchObject({ id: 'free' });
        });

        it('stops offering a declined one', async () => {
            const { id } = await pendingOne();

            await service.decline(id);

            expect(await service.list()).toEqual([]);
            await expect(service.decline(id)).rejects.toMatchObject({ statusCode: 409 });
        });

        it('stops offering one past its 45 days, and refuses to decide it', async () => {
            const { id } = await pendingOne();
            expect((await service.list())[0]?.expiresAt.diff(DateTime.now(), 'days').days).toBeCloseTo(RULE_PROPOSAL_LIFETIME.as('days'), 0);
            await db
                .updateTable('wilson.ruleProposals')
                .set({ expiresAt: DateTime.now().minus({ minutes: 1 }) })
                .where('id', '=', BigInt(id))
                .execute();

            expect(await service.list()).toEqual([]);
            await expect(service.accept(id, { id: 'late' })).rejects.toMatchObject({ statusCode: 409 });
        });

        it('keeps one project out of another', async () => {
            const { id } = await pendingOne();
            const other = new RuleProposalRepository(new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run'), db);

            expect(await other.pending()).toEqual([]);
            expect(await other.decline(id)).toBeUndefined();
        });
    });
});
