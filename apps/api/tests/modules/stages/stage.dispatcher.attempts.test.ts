import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore, type StageConfigStore } from '#modules/stages/stage.config.store.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier, type VerificationOutcome } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const baseCard: Card = {
    frontmatter: {
        id: '0001',
        title: 'do the thing',
        stage: 'implementing',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.',
};

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    name: 'implementing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'implement it',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
    ...overrides,
});

const outcome = (overrides: Partial<StageOutcome> = {}): StageOutcome => ({
    passed: true,
    failures: [],
    changedPaths: [],
    scopeGrants: [],
    usage: {},
    ...overrides,
});

/**
 * Card 0234: a stage kicked back after a judged failure sees, as part of its own plan file, why
 * its previous attempts failed. `StageDispatcher.writeTransition` now folds a `## Previous attempts`
 * bullet into the card body on a judged failure (`append.attempts.ts`), sheds the section on a pass,
 * and — the same "card 0091" pin-advance fix findings already got — advances a pinned card's
 * `planVersionId` whenever the write actually changed the body, not only when findings did.
 *
 * These exercise `writeTransition` directly (private access, same pattern `stage.dispatcher.test.ts`
 * and `stage.dispatcher.plan-pin-advance.test.ts` already use) against a real `PostgresBoardRepository`,
 * so the body asserted on is what actually landed, not a re-implementation of `withAttempt`'s logic.
 */
describe('StageDispatcher writeTransition records why a stage’s previous attempts failed (card 0234)', () => {
    let board: BoardRepository;
    let dispatcher: StageDispatcher;
    let worktrees: { failedAttemptPatchPath: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-attempts-'));

        const events = { append: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(baseCard, 'initial');

        // A judged failure calls `WorktreeManager.failedAttemptPatchPath` unconditionally (to fill in
        // `Attempt.patchPath`) — this has to be a real function, not `{}`, for those cases.
        worktrees = { failedAttemptPatchPath: vi.fn((cardId: string) => join(config.runRoot, 'cards', cardId, 'last-failed-attempt.patch')) };

        dispatcher = new StageDispatcher(
            config as BoardConfig,
            {} as StageConfigStore,
            board,
            worktrees as unknown as WorktreeManager,
            {} as StageAgentMap,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            events as unknown as EventLog,
            silentLogger as never,
        );
    });

    const writeTransition = (stage: StageConfig, head: Card, result: StageOutcome, card: Card = head) =>
        (
            dispatcher as unknown as {
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    head: Card,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0001', 'implementing', stage, head, card, result);

    it('adds a bullet naming the stage, "attempt N of M", and each verifier failure (AC1)', async () => {
        const stage = makeStage({ maxKickbacks: 3 });
        const head = await board.read('0001');

        await writeTransition(stage, head, outcome({ passed: false, failures: ['diff is empty', 'build failed: type error'] }));

        const stored = await board.read('0001');
        expect(stored.body).toContain('## Previous attempts');
        expect(stored.body).toContain('**implementing** attempt 1 of 3');
        expect(stored.body).toContain('diff is empty');
        expect(stored.body).toContain('build failed: type error');
    });

    it('adds a second bullet on a second judged failure, keeping the first (AC2)', async () => {
        const stage = makeStage({ maxKickbacks: 5 });
        const head1 = await board.read('0001');

        await writeTransition(stage, head1, outcome({ passed: false, failures: ['first failure'] }));
        const head2 = await board.read('0001');

        await writeTransition(stage, head2, outcome({ passed: false, failures: ['second failure'] }));

        const stored = await board.read('0001');
        expect(stored.body).toContain('attempt 1 of 5');
        expect(stored.body).toContain('first failure');
        expect(stored.body).toContain('attempt 2 of 5');
        expect(stored.body).toContain('second failure');
        expect(stored.body.match(/## Previous attempts/g)).toHaveLength(1);
    });

    it('removes the "## Previous attempts" section on a pass, leaving every other section byte-identical (AC3)', async () => {
        const stage = makeStage();
        const head1 = await board.read('0001');
        await writeTransition(stage, head1, outcome({ passed: false, failures: ['it failed'] }));

        const failed = await board.read('0001');
        expect(failed.body).toContain('## Previous attempts');
        // The exact other-section text this failure's write is not allowed to touch.
        expect(failed.body).toContain('## Goal\n\nDo the thing.');

        const passStage = makeStage({ name: 'implementing', onPass: 'review' });
        const passCard: Card = { ...failed, frontmatter: { ...failed.frontmatter, stage: 'implementing' } };
        await writeTransition(passStage, failed, outcome({ passed: true, result: { summary: 'done' } }), passCard);

        const passed = await board.read('0001');
        expect(passed.body).not.toContain('Previous attempts');
        // The section is fully gone; the "Goal" text itself is untouched, byte for byte (trailing
        // whitespace aside — the same replace-section algorithm `withFindings` already uses can leave
        // one blank line behind when the removed section was the last thing in the body).
        expect(passed.body.trim()).toBe('## Goal\n\nDo the thing.');
        expect(passed.body.match(/^## Goal\n\nDo the thing\.\n?$/)).not.toBeNull();
    });

    it('adds no bullet for an unjudged failure (AC4)', async () => {
        const stage = makeStage();
        const head = await board.read('0001');

        await writeTransition(stage, head, outcome({ passed: false, unjudged: true, failures: ['step budget exhausted'] }));

        const stored = await board.read('0001');
        expect(stored.body).not.toContain('Previous attempts');
        expect(stored.body).toBe(baseCard.body);
    });

    it('adds no bullet for a resultDropped failure (AC4)', async () => {
        const stage = makeStage();
        const head = await board.read('0001');

        await writeTransition(stage, head, outcome({ passed: false, unjudged: true, resultDropped: true, failures: ['result never arrived'] }));

        const stored = await board.read('0001');
        expect(stored.body).not.toContain('Previous attempts');
        expect(stored.body).toBe(baseCard.body);
    });

    it('advances a pinned card’s planVersionId past a judged failure that wrote only an attempts bullet, no findings', async () => {
        const created = await board.create({ ...baseCard, frontmatter: { ...baseCard.frontmatter, id: '0002' } }, 'initial');
        await board.write('0002', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));
        const head = await board.read('0002');
        expect(head.frontmatter.planVersionId).toBe(created);

        const stage = makeStage();
        await (
            dispatcher as unknown as {
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    head: Card,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0002', 'implementing', stage, head, head, outcome({ passed: false, failures: ['build failed'] }));

        const stored = await board.read('0002');
        // The pin moved off the pre-kickback version — before this card, only non-empty findings
        // advanced it; an attempts-only write must too, or a retried stage's materialised plan.md
        // (see the end-to-end test below) would still read the stale, pre-failure pin.
        expect(stored.frontmatter.planVersionId).toBeDefined();
        expect(stored.frontmatter.planVersionId).not.toBe(created);

        const pinned = await board.readAt('0002', stored.frontmatter.planVersionId!);
        expect(pinned.body).toContain('## Previous attempts');
        expect(pinned.body).toContain('build failed');
    });

    it('leaves a pinned card’s planVersionId untouched when the failure is unjudged and writes no bullet', async () => {
        const created = await board.create({ ...baseCard, frontmatter: { ...baseCard.frontmatter, id: '0003' } }, 'initial');
        await board.write('0003', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));
        const head = await board.read('0003');

        const stage = makeStage();
        await (
            dispatcher as unknown as {
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    head: Card,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0003', 'implementing', stage, head, head, outcome({ passed: false, unjudged: true, failures: ['ran out of steps'] }));

        const stored = await board.read('0003');
        expect(stored.frontmatter.planVersionId).toBe(created);
    });
});

/**
 * Card 0234's payoff, end to end through `run()`: a pinned card kicked back on a judged failure that
 * carries no review findings — an implementing/testing-style stage, not a review — must still hand
 * the retried stage a materialised `plan.md` containing the `## Previous attempts` bullet, not the
 * stale pre-failure plan. Before this card, `writeTransition` only ever advanced the pin for
 * non-empty findings, so an attempts-only write (the common case for implementing and testing) would
 * have left the pin — and the next dispatch's materialised plan — exactly where it was.
 *
 * Structured after `stage.dispatcher.plan-pin-advance.test.ts`'s own end-to-end block: one
 * self-looping stage (`onFail: implementing`, matching `testing.onFail: testing`'s real shape),
 * `worktrees` fully mocked, real `PostgresBoardRepository` and `run()`.
 */
describe('StageDispatcher’s next dispatch reads the attempts bullet a prior judged failure just wrote (card 0234, end to end)', () => {
    const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: merged
    onFail: implementing
    worktreeFrom: branch
`;

    const seedCard: Card = {
        frontmatter: {
            id: '0001',
            title: 'do the thing',
            stage: 'implementing',
            dependsOn: [],
            retries: {},
        },
        sections: { 'Files in scope': '- src/x.ts' },
        body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
    };

    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-attempts-e2e-'));

        const worktreeDir = join(base, 'worktree');
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);

        const created = await board.create(seedCard, 'seed');
        // Pinned once, at "approval", to the pre-kickback version — the one whose body has no
        // attempts section — matching what `approve` does in production.
        await board.write('0001', 'approve', c => ({ ...c, frontmatter: { ...c.frontmatter, planVersionId: created } }));

        const worktrees = {
            resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
            hasWork: vi.fn(async () => true),
            create: vi.fn(async () => {
                throw new Error('MARKER: should not create — a self-loop resumes (worktreeFrom: branch)');
            }),
            resume: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
            rebaseOntoHead: vi.fn(async () => ({ ok: true, baseSha: 'deadbeef' })),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            failedAttemptPatchPath: vi.fn(() => join(config.runRoot, 'cards', '0001', 'last-failed-attempt.patch')),
        };

        return { config, board, events, worktrees, created };
    };

    // The verifier fails the first call (a judged failure — a bad diff, not an engine hiccup) and
    // passes the second, so the same stage can be dispatched twice: once to produce the attempt, once
    // to be the retry that must see it in its own materialised plan.
    const buildDispatcher = (
        config: StaticBoardConfig,
        board: BoardRepository,
        events: { append: ReturnType<typeof vi.fn> },
        worktrees: unknown,
    ) => {
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (): Promise<AgentRunOutput> => ({
                result: { summary: 'attempted the fix', filesTouched: ['src/x.ts'] },
                usage: { inputTokens: 10 },
                truncated: false,
            }),
        });

        let verifyCalls = 0;
        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = {
            verify: async (): Promise<VerificationOutcome> => {
                verifyCalls += 1;
                return verifyCalls === 1
                    ? { passed: false, failures: ['build failed: type error on line 3'], changedPaths: ['src/x.ts'] }
                    : { passed: true, failures: [], changedPaths: ['src/x.ts'] };
            },
        };
        verifiers.set('implementing', verifier);

        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('implementing', {} as never);

        return new StageDispatcher(
            config,
            new StaticStageConfigStore(stagesYaml),
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
        );
    };

    it('materializes a plan.md carrying the "## Previous attempts" bullet for the retry dispatched right after the failure (AC5)', async () => {
        const { config, board, worktrees, events, created } = await setUp();
        const dispatcher = buildDispatcher(config, board, events, worktrees);

        const first = await dispatcher.run('0001', 'implementing');
        expect(first.passed).toBe(false);
        expect(first.transitionedTo).toBe('implementing');

        const afterFirst = await board.read('0001');
        expect(afterFirst.frontmatter.planVersionId).toBeDefined();
        expect(afterFirst.frontmatter.planVersionId).not.toBe(created);

        const pinnedNow = await board.readAt('0001', afterFirst.frontmatter.planVersionId!);
        expect(pinnedNow.body).toContain('## Previous attempts');
        expect(pinnedNow.body).toContain('build failed: type error on line 3');

        // The retry: same stage, dispatched again. Its own materialised plan.md — what the agent
        // actually reads — must carry the bullet the first failure just wrote, not the stale
        // pre-failure plan (the regression this card generalizes card 0129's fix to cover).
        const second = await dispatcher.run('0001', 'implementing');
        expect(second.passed).toBe(true);

        const plan = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(plan).toContain('## Previous attempts');
        expect(plan).toContain('attempt 1 of');
        expect(plan).toContain('build failed: type error on line 3');
    });
});
