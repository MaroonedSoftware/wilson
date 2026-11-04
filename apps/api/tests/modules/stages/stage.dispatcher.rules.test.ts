import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { Card } from '#modules/board/card.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { RuleJudge } from '#modules/rules/rule.judge.js';
import { RuleJudgeEngine, RuleJudgeEngineMap, type RuleJudgeCall, type RuleJudgeReply } from '#modules/rules/rule.judge.engine.js';
import { PostgresRuleStore } from '#modules/rules/rule.store.js';
import { RuleVerdictStore } from '#modules/rules/rule.verdict.store.js';
import { ChallengeVerifier } from '#modules/stages/challenge.verifier.js';
import { ReviewVerifier } from '#modules/stages/review.verifier.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { ChallengeResultSchema, ReviewResultSchema, StageResultSchemaMap, type ReviewResult } from '#modules/stages/stage.result.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { defaultSettings } from '#tests/support/fake.settings.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const stagesYaml = `
stages:
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    worktreeFrom: branch
    onPass: ready
    onFail: implementing
    maxKickbacks: 3
    steps:
      - name: challenge
        on: revise
        instructions: challenge it
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: merged
    onFail: implementing
  - name: ready
    mode: manual
    model: claude-opus
    instructions: human gate
    onPass: merged
    onFail: ready
`;

const cleanReview: ReviewResult = { summary: 'Reviewed.', verdict: 'pass', findings: [], criteria: [] };
const failing = (line: number | undefined): RuleJudgeReply => ({
    text: JSON.stringify({ verdict: 'fail', evidence: 'It builds SQL by hand.', ...(line === undefined ? {} : { file: 'src/changed.ts', line }) }),
    usage: { inputTokens: 1000, cachedInputTokens: 200, cacheWriteInputTokens: 100, outputTokens: 50 },
});
const PROBLEM = 'Rule no-raw-sql failed: It builds SQL by hand.';

class ScriptedEngine extends RuleJudgeEngine {
    calls = 0;
    constructor(public answer: (call: RuleJudgeCall) => RuleJudgeReply) {
        super();
    }
    async ask(call: RuleJudgeCall): Promise<RuleJudgeReply> {
        this.calls++;
        return this.answer(call);
    }
}

/** A card in review, with a real commit on its branch and a real rule, driven by a scripted review and judge. */
const setUp = async ({
    judge,
    review = () => cleanReview,
    challenge,
    paths = ['src/**'],
}: {
    judge: (call: RuleJudgeCall) => RuleJudgeReply;
    review?: () => unknown;
    challenge?: unknown;
    paths?: string[];
}) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-rules-'));
    const codeRoot = join(base, 'code');
    await mkdir(join(codeRoot, 'src'), { recursive: true });
    await writeFile(join(codeRoot, 'src', 'kept.ts'), 'export const kept = 1;\n', 'utf8');
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
    await exec('git', ['add', '-A'], { cwd: codeRoot });
    await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

    const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(base, 'worktrees'), join(base, 'run'));
    const events = new EventLog(db, silentLogger as never);
    const board = new PostgresBoardRepository(config, db, events);
    const worktrees = new WorktreeManager(config, silentLogger as never);

    const seedCard: Card = {
        frontmatter: { id: '0001', title: 'fix the loop', stage: 'review', dependsOn: [], retries: {} },
        sections: { 'Files in scope': '- src/changed.ts' },
        body: '## Goal\n\nFix the loop.\n\n## Files in scope\n\n- src/changed.ts\n',
    };
    await board.create(seedCard, 'seed');
    const seedWorktree = await worktrees.create('0001', worktrees.resolveBranch(seedCard));
    await writeFile(join(seedWorktree.path, 'src', 'changed.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
    await worktrees.commit(seedWorktree, 'implement the thing');
    await worktrees.reclaim('0001');

    const rules = new PostgresRuleStore(config, db);
    await rules.create('no-raw-sql', { statement: 'Queries go through Kysely', paths, severity: 'blocker' }, 'x');

    const engine = new ScriptedEngine(judge);
    const engines = new RuleJudgeEngineMap();
    engines.set('cli', engine);
    const ruleJudge = new RuleJudge(new RuleVerdictStore(config, db), defaultSettings, engines, silentLogger as never);

    const plans: Record<string, string> = {};
    const agents = new StageAgentMap();
    agents.set('api', {
        run: async (input: AgentRunInput): Promise<AgentRunOutput> => {
            plans[input.stage.step ?? input.stage.name] = await readFile(input.planPath, 'utf8');
            if (input.stage.step === 'challenge') return { result: challenge, usage: { inputTokens: 5 }, truncated: false };
            return { result: review(), usage: { inputTokens: 10 }, truncated: false };
        },
    });

    const reviewVerifier = new ReviewVerifier(worktrees, silentLogger as never);
    const verifiers = new StageVerifierMap();
    verifiers.set('review', reviewVerifier);
    verifiers.set('challenge', new ChallengeVerifier(reviewVerifier, events, config));
    const resultSchemas = new StageResultSchemaMap();
    resultSchemas.set('review', ReviewResultSchema);
    resultSchemas.set('challenge', ChallengeResultSchema);

    const dispatcher = new StageDispatcher(
        config,
        new StaticStageConfigStore(stagesYaml),
        board,
        worktrees,
        agents,
        verifiers,
        resultSchemas,
        events,
        silentLogger as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        rules,
        ruleJudge,
    );

    const ruleEvents = async () => {
        const rows = await events.tail(config.project, '0001');
        return rows.filter(row => row.type === 'rule.verdicts');
    };

    return { dispatcher, board, engine, events, config, plans, ruleEvents };
};

describe('StageDispatcher judges rules at review', () => {
    it('turns a failure citing a real line into a blocker, through challenge, to a kickback', async () => {
        const blocker = {
            severity: 'blocker',
            kind: 'defect',
            file: 'src/changed.ts',
            line: 2,
            problem: PROBLEM,
            suggestion: 'Change the code so that this holds: Queries go through Kysely',
        };
        const { dispatcher, board, engine, plans } = await setUp({
            judge: () => failing(2),
            challenge: { summary: 'It stands.', verdict: 'revise', findings: [blocker], refuted: [] },
        });

        const reviewed = await dispatcher.run('0001', 'review');

        expect(reviewed.passed).toBe(true);
        expect((reviewed.result as ReviewResult).verdict).toBe('revise');
        expect((reviewed.result as ReviewResult).findings).toEqual([blocker]);
        expect(reviewed.nextStep).toBe('challenge');
        expect(plans.review).toContain('## Rule verdicts');
        expect(plans.review).toContain('**no-raw-sql**: failed at src/changed.ts:2. It builds SQL by hand.');

        const challenged = await dispatcher.run('0001', 'review', undefined, 'challenge');

        expect(challenged.passed).toBe(true);
        expect(challenged.transitionedTo).toBe('implementing');
        expect(plans.challenge).toContain(`- src/changed.ts:2: ${PROBLEM}`);
        const after = await board.read('0001');
        expect(after.frontmatter.stage).toBe('implementing');
        expect(after.frontmatter.retries).toEqual({ review: 1 });
        expect(after.body).toContain(PROBLEM);
        // The step judges the review's report, and no rule again.
        expect(engine.calls).toBe(1);
    });

    it('lets challenge refute a rule blocker as it can any other', async () => {
        const { dispatcher, board } = await setUp({
            judge: () => failing(2),
            challenge: {
                summary: 'It does not hold.',
                verdict: 'pass',
                findings: [],
                refuted: [{ problem: PROBLEM, reason: 'That is a Kysely call.' }],
            },
        });

        await dispatcher.run('0001', 'review');
        const challenged = await dispatcher.run('0001', 'review', undefined, 'challenge');

        expect(challenged.passed).toBe(true);
        expect(challenged.transitionedTo).toBe('ready');
        expect((await board.read('0001')).frontmatter.stage).toBe('ready');
    });

    it('leaves an uncited failure a concern, which does not stop the card', async () => {
        const { dispatcher, board } = await setUp({ judge: () => failing(undefined) });

        const reviewed = await dispatcher.run('0001', 'review');

        expect(reviewed.transitionedTo).toBe('ready');
        expect((reviewed.result as ReviewResult).verdict).toBe('pass');
        expect((reviewed.result as ReviewResult).findings[0]).toMatchObject({ severity: 'concern', kind: 'omission', problem: PROBLEM });
        expect((await board.read('0001')).body).toContain(PROBLEM);
    });

    it('does not let a citation past the end of the file stop the card, or reject the review', async () => {
        const { dispatcher } = await setUp({ judge: () => failing(500) });

        const reviewed = await dispatcher.run('0001', 'review');

        expect(reviewed.passed).toBe(true);
        expect(reviewed.transitionedTo).toBe('ready');
    });

    it('stays advisory when the engine fails: the card moves on and the plan says so', async () => {
        const { dispatcher, engine, plans, ruleEvents } = await setUp({
            judge: () => {
                throw new Error('engine down');
            },
        });

        const reviewed = await dispatcher.run('0001', 'review');

        expect(reviewed.passed).toBe(true);
        expect(reviewed.transitionedTo).toBe('ready');
        expect((reviewed.result as ReviewResult).findings).toEqual([]);
        expect(engine.calls).toBe(2);
        expect(plans.review).toContain('**no-raw-sql**: no verdict, so it stops nothing (engine down).');
        expect((await ruleEvents())[0]?.payload).toMatchObject({ verdicts: [{ rule: 'no-raw-sql', verdict: 'unavailable' }] });
    });

    it('makes no new judge calls when the review runs again over the same code', async () => {
        let report: unknown = { summary: 'garbage' };
        const { dispatcher, engine, ruleEvents } = await setUp({ judge: () => failing(2), review: () => report });

        // A report the schema refuses is sent round again, and the rule was already answered.
        const first = await dispatcher.run('0001', 'review');
        expect(first.passed).toBe(false);
        expect(first.transitionedTo).toBe('review');
        expect(engine.calls).toBe(1);

        report = cleanReview;
        const second = await dispatcher.run('0001', 'review');

        expect(engine.calls).toBe(1);
        expect((second.result as ReviewResult).verdict).toBe('revise');
        const [, again] = await ruleEvents();
        expect(again?.payload).toMatchObject({ verdicts: [{ rule: 'no-raw-sql', verdict: 'fail', reused: true }] });
        expect(again?.payload.usage).toBeUndefined();
    });

    it('leaves no trace when no rule matches', async () => {
        const { dispatcher, engine, plans, ruleEvents } = await setUp({ judge: () => failing(2), paths: ['docs/**'] });

        const reviewed = await dispatcher.run('0001', 'review');

        expect(reviewed.transitionedTo).toBe('ready');
        expect(engine.calls).toBe(0);
        expect(await ruleEvents()).toEqual([]);
        expect(plans.review).not.toContain('Rule verdicts');
    });

    it("charges what the judges spent to the card's budget, and to review's usage, as no attempt", async () => {
        const { dispatcher, events, config } = await setUp({ judge: () => failing(undefined) });

        await dispatcher.run('0001', 'review');

        // The review's own 10, plus 1000 fresh, 100 cached reads at 0.1 and 100 cached writes at 1.25.
        expect(await events.budgetedInputTokens(config.project, '0001')).toBe(10 + 1000 + 10 + 125);
        const usage = await events.usageByStage(config.project, '0001');
        expect(usage.total.outputTokens).toBe(50);
        expect(usage.stages).toEqual([expect.objectContaining({ stage: 'review', attempts: 1, inputTokens: 1210, cachedInputTokens: 200 })]);
    });

    describe('naming what a challenge upheld, for a rule to be proposed from', () => {
        const blocker = {
            severity: 'blocker',
            kind: 'defect',
            file: 'src/changed.ts',
            line: 2,
            problem: 'The review found this.',
            suggestion: 'Fix it.',
        };
        const review = () => ({ summary: 'One blocker.', verdict: 'revise', findings: [blocker], criteria: [] });
        const passing = () => ({ text: '{"verdict":"pass","evidence":"fine"}' });

        it('names one that sent the card back', async () => {
            const { dispatcher } = await setUp({
                judge: passing,
                review,
                challenge: { summary: 'It stands.', verdict: 'revise', findings: [blocker], refuted: [] },
            });

            await dispatcher.run('0001', 'review');
            const challenged = await dispatcher.run('0001', 'review', undefined, 'challenge');

            expect(challenged.transitionedTo).toBe('implementing');
            expect(challenged.upheldBlockers).toEqual([blocker]);
        });

        it('names nothing for the review itself, before anyone has challenged it', async () => {
            const { dispatcher } = await setUp({ judge: passing, review });

            expect((await dispatcher.run('0001', 'review')).upheldBlockers).toBeUndefined();
        });

        it('names nothing for a blocker the challenge refuted', async () => {
            const { dispatcher } = await setUp({
                judge: passing,
                review,
                challenge: { summary: 'No.', verdict: 'pass', findings: [], refuted: [{ problem: blocker.problem, reason: 'It is fine.' }] },
            });

            await dispatcher.run('0001', 'review');

            expect((await dispatcher.run('0001', 'review', undefined, 'challenge')).upheldBlockers).toBeUndefined();
        });

        it('names nothing for a failure of a rule, which already has one', async () => {
            const ruleBlocker = { ...blocker, problem: PROBLEM };
            const { dispatcher } = await setUp({
                judge: () => failing(2),
                challenge: { summary: 'It stands.', verdict: 'revise', findings: [ruleBlocker], refuted: [] },
            });

            await dispatcher.run('0001', 'review');

            expect((await dispatcher.run('0001', 'review', undefined, 'challenge')).upheldBlockers).toBeUndefined();
        });
    });
});
