import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { BlockedReport } from '#modules/agent/blocked.report.js';
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import type { CardNotification } from '#modules/notify/notification.js';
import { registerNotificationChannel } from '#modules/notify/notifier.js';
import { NotDispatchableError, StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { ImplementingResultSchema, StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

const STAGES = `
stages:
  - name: implementing
    mode: agent
    adapter: cli
    model: claude-opus-5
    instructions: build it
    onPass: testing
    onFail: testing
    maxKickbacks: 3
  - name: testing
    mode: agent
    adapter: cli
    model: claude-opus-5
    instructions: test it
    onPass: merged
    onFail: testing
`;

const REPORT: BlockedReport = {
    category: 'decision',
    tried: 'read the callers',
    question: 'Should the old endpoint keep working?',
    options: ['keep it', 'remove it'],
    recommended: 'keep it: two callers still read it',
};

const PLAN = '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/kept.ts\n';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** Real board, real git and real event log; a stub agent, since what matters is what becomes of the card. */
describe('StageDispatcher parking a stage that asked a question', () => {
    let sent: CardNotification[];
    let unregister: () => void;

    beforeEach(() => {
        sent = [];
        unregister = registerNotificationChannel({
            name: 'test',
            send: async notification => {
                sent.push(notification);
            },
        });
    });
    afterEach(() => unregister());

    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-blocked-'));
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
        const stageConfigs = new StaticStageConfigStore(STAGES);
        const worktrees = new WorktreeManager(config, silentLogger as never);

        await board.create(
            {
                frontmatter: { id: '0001', title: 'a card', stage: 'implementing', dependsOn: [], retries: {} },
                sections: { 'Files in scope': '- src/kept.ts' },
                body: PLAN,
            },
            'seed',
        );
        const pin = await board.currentVersion('0001');
        await board.write('0001', 'pin', card => ({ ...card, frontmatter: { ...card.frontmatter, planVersionId: pin } }));

        const verified: string[] = [];
        const verifier: StageVerifier = {
            verify: async ({ stage }) => {
                verified.push(stage.name);
                return { passed: true, failures: [], changedPaths: [] };
            },
        };
        const verifiers = new StageVerifierMap();
        verifiers.set('implementing', verifier);
        const schemas = new StageResultSchemaMap();
        schemas.set('implementing', ImplementingResultSchema);

        const agents = new StageAgentMap();
        const planSeen: string[] = [];
        let next: (input: AgentRunInput) => Promise<AgentRunOutput> = async () => ({ truncated: true });
        agents.set('cli', {
            run: async (input: AgentRunInput) => {
                planSeen.push(await readFile(input.planPath, 'utf8'));
                return next(input);
            },
        } as never);

        const dispatcher = new StageDispatcher(config, stageConfigs, board, worktrees, agents, verifiers, schemas, events, silentLogger as never);
        const writes = new BoardWriteService(
            board,
            config,
            worktrees,
            events,
            silentLogger as never,
            { inFlight: vi.fn(async () => undefined) } as never,
            { send: vi.fn() } as never,
            new RunningCards(),
            { get: vi.fn() } as never,
            stageConfigs,
        );

        const typesOf = async (): Promise<string[]> => (await events.tail(config.project, '0001', 100)).map(event => event.type);
        const asks = (report: BlockedReport = REPORT): void => {
            next = async () => ({ blocked: report, truncated: false, usage: { inputTokens: 100, outputTokens: 7 } });
        };
        const run = (): ReturnType<StageDispatcher['run']> => dispatcher.run('0001', 'implementing');
        return {
            board,
            config,
            events,
            writes,
            worktrees,
            typesOf,
            verified,
            planSeen,
            asks,
            run,
            behave: (behaviour: typeof next) => {
                next = behaviour;
            },
        };
    };

    it('flags the card with the question, writes no stage.failed, spends no retry and skips the verifier', async () => {
        const { board, typesOf, verified, asks, run } = await setUp();
        asks();

        const outcome = await run();

        expect(outcome).toMatchObject({ passed: false, needsHuman: true, transitionedTo: 'implementing', blocked: REPORT });
        const { frontmatter } = await board.read('0001');
        expect(frontmatter.stage).toBe('implementing');
        expect(frontmatter.needsHuman).toBe(true);
        expect(frontmatter.needsHumanReason).toBe(REPORT.question);
        expect(frontmatter.blocked).toMatchObject({ ...REPORT, stage: 'implementing', askedAt: expect.any(String) });
        expect(frontmatter.blocked?.patchPath).toBeUndefined();
        expect(frontmatter.retries).toEqual({ 'implementing:blocked': 1 });
        expect(verified).toEqual([]);

        const types = await typesOf();
        expect(types).toContain('stage.blocked');
        expect(types).not.toContain('stage.failed');
        expect(types).not.toContain('stage.passed');
    });

    it('counts what the run spent', async () => {
        const { config, events, asks, run } = await setUp();
        asks();

        await run();

        expect(await events.budgetedInputTokens(config.project, '0001')).toBe(100);
        const usage = await events.usageByStage(config.project, '0001');
        expect(usage.total).toMatchObject({ attempts: 0, inputTokens: 100, outputTokens: 7 });
    });

    it('sends the needs-answer moment, once, with the question', async () => {
        const { asks, run } = await setUp();
        asks();

        await run();

        expect(sent).toEqual([
            { project: expect.any(String), cardId: '0001', title: 'a card', stage: 'implementing', moment: 'needs-answer', reason: REPORT.question },
        ]);
    });

    it('will not dispatch again until answered', async () => {
        const { asks, run } = await setUp();
        asks();
        await run();

        await expect(run()).rejects.toBeInstanceOf(NotDispatchableError);
    });

    it('names the preserved patch when the run left uncommitted work, and the next run can read it', async () => {
        const { board, writes, worktrees, asks, run, behave, planSeen } = await setUp();
        behave(async ({ context }) => {
            await writeFile(join(context.worktreeRoot, 'src', 'kept.ts'), 'export const kept = 2;\n', 'utf8');
            return { blocked: REPORT, truncated: false };
        });
        await run();

        const patchPath = worktrees.failedAttemptPatchPath('0001');
        expect((await board.read('0001')).frontmatter.blocked?.patchPath).toBe(patchPath);

        await writes.answer('0001', { answer: 'Keep it.' });
        asks();
        await run();

        expect(planSeen[1]).toContain(`\`${patchPath}\``);
        expect(await readFile(patchPath, 'utf8')).toContain('export const kept = 2;');
    });

    it('resumes after an answer in a fresh session, reading the answer at the moved pin, with retries kept', async () => {
        const { board, writes, asks, run, behave, planSeen } = await setUp();
        await board.write('0001', 'kicked back once', card => ({ ...card, frontmatter: { ...card.frontmatter, retries: { implementing: 2 } } }));
        asks();
        await run();

        await writes.answer('0001', { answer: 'Keep it for one release.' });

        const answered = await board.read('0001');
        expect(answered.frontmatter.needsHuman).toBeFalsy();
        expect(answered.frontmatter.retries).toEqual({ implementing: 2, 'implementing:blocked': 1 });

        const resumes: (string | undefined)[] = [];
        behave(async input => {
            resumes.push(input.resume?.sessionId);
            return { result: { summary: 'done', caveats: [] }, truncated: false };
        });
        const outcome = await run();

        expect(planSeen[1]).toContain('> Keep it for one release.');
        expect(resumes).toEqual([undefined]);
        expect(outcome.transitionedTo).toBe('testing');
        const passed = await board.read('0001');
        expect(passed.body).not.toContain('Operator answer');
        expect(passed.frontmatter.needsHuman).toBeFalsy();
    });

    it('flags with nothing to answer once a stage has asked three times', async () => {
        const { board, writes, asks, run } = await setUp();
        asks();
        for (const round of [1, 2, 3]) {
            await run();
            expect((await board.read('0001')).frontmatter.retries['implementing:blocked']).toBe(round);
            await writes.answer('0001', { answer: `answer ${round}` });
        }

        asks({ ...REPORT, question: 'And another thing?' });
        await run();

        const { frontmatter } = await board.read('0001');
        expect(frontmatter.needsHuman).toBe(true);
        expect(frontmatter.blocked).toBeUndefined();
        expect(frontmatter.needsHumanReason).toBe('"implementing" has asked 3 questions already and asked another: And another thing?');
        expect(sent.at(-1)?.moment).toBe('needs-human');
        await expect(writes.answer('0001', { answer: 'Nope.' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('gives a stage its questions back on an ack, at the cap', async () => {
        const { board, writes, asks, run } = await setUp();
        await board.write('0001', 'spent', card => ({ ...card, frontmatter: { ...card.frontmatter, retries: { 'implementing:blocked': 3 } } }));
        asks();
        await run();
        expect((await board.read('0001')).frontmatter.blocked).toBeUndefined();

        await writes.ack('0001');
        await run();

        expect((await board.read('0001')).frontmatter.blocked?.question).toBe(REPORT.question);
    });

    it('lets a ticket closed during the run win over the question', async () => {
        const { board, behave, run, typesOf } = await setUp();
        behave(async () => {
            await board.write('0001', 'closed upstream', card => ({ ...card, frontmatter: { ...card.frontmatter, sourceClosed: true } }));
            return { blocked: REPORT, truncated: false };
        });

        const outcome = await run();

        expect(outcome.needsHuman).toBe(true);
        const { frontmatter } = await board.read('0001');
        expect(frontmatter.needsHumanReason).toBe('source-closed');
        expect(frontmatter.blocked).toBeUndefined();
        expect(frontmatter.retries).toEqual({});
        expect(sent.map(notification => notification.moment)).toEqual(['needs-human']);
        expect(await typesOf()).toContain('stage.blocked');
    });

    it('leaves a card a person moved during the run where they put it', async () => {
        const { board, behave, run, typesOf } = await setUp();
        behave(async () => {
            await board.write('0001', 'moved by hand', card => ({ ...card, frontmatter: { ...card.frontmatter, stage: 'testing' } }));
            return { blocked: REPORT, truncated: false };
        });

        const outcome = await run();

        expect(outcome.transitionedTo).toBeUndefined();
        const { frontmatter } = await board.read('0001');
        expect(frontmatter.stage).toBe('testing');
        expect(frontmatter.needsHuman).toBeFalsy();
        expect(frontmatter.blocked).toBeUndefined();
        expect(sent).toEqual([]);
        expect(await typesOf()).toContain('stage.stale');
    });
});
