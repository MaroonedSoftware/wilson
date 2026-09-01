import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { ScopeDecision } from '#modules/agent/scope.guard.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { BoardConfig } from '#modules/board/board.config.js';
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

// `backlog` is manual, its own onPass is irrelevant here — this test moves the card on to
// `testing` explicitly (`writeService.move('0001', { stage: 'testing' })`), standing in for the
// poller's own second step, rather than reading it from config the way `approve` used to.
const stagesYaml = `
stages:
  - name: backlog
    mode: manual
    model: claude-opus
    instructions: read the plan
    onPass: testing
    onFail: backlog
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test the thing
    onPass: merged
    onFail: testing
    maxKickbacks: 3
`;

const approvedBody = '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n';

const seedCard: Card = {
    frontmatter: {
        id: '0001',
        title: 'do the thing',
        stage: 'planning',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: approvedBody,
};

/**
 * Card 0109's own bug report: "the first time `wilson card approve` was ever used on this board" —
 * approving a card and then dispatching it poisoned the card immediately, because
 * `assertDispatchable` checked the *pinned* plan snapshot's `stage` instead of the live card's
 * stage. The fix (using `head`, the live row, for that check) has to keep holding no matter how a
 * card's plan version comes to be pinned at a stage other than the one it is dispatched at.
 *
 * Card 0127 moved *where* the pin happens — entering `backlog` now, not leaving it — and made
 * leaving `backlog` a second, separate write (the poller's job, or a plain `move`) that never
 * re-pins. That reshapes this test's setup into two steps instead of one (`approve` from
 * `planning` into `backlog`, pinning; then `move` out of `backlog` into an agent stage, same as the
 * poller's own `advanceBacklogCard`) without changing what it is actually proving: the pinned
 * snapshot's own `frontmatter.stage` (`planning`, here) still differs from the live card's stage
 * (`testing`) at dispatch time, and that must not poison the card.
 *
 * This wires up the real `BoardWriteService` against a real Postgres board, then runs
 * `StageDispatcher.run` all the way to a passing, committed transition, the way
 * `stage.dispatcher.collateral.test.ts` drives a full run: a real git worktree, a stub agent adapter
 * and verifier standing in for the model, everything else real. Asserting on the reads in isolation
 * (as the pre-0109 test suite did) is exactly what hid this, per the card's own acceptance criteria —
 * this exercises the seam between approving/advancing a card and running it, where the bug actually
 * lived.
 */
describe('approving a card and then dispatching it (card 0109)', () => {
    const setUp = async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-approve-'));
        const boardRoot = join(base, 'board');
        await mkdir(join(boardRoot, 'cards'), { recursive: true });

        const worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await writeFile(join(worktreeDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
        await writeFile(join(worktreeDir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), boardRoot, join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(seedCard, 'seed');

        // `approve`'s other collaborators (worktrees, cardJobs, broker, runningCards, settings) are never
        // touched by `approve()` itself — it only reads/writes the board and stage config — so they
        // are stand-ins here, the same way board.write.service.test.ts's own `approve` suite treats
        // them.
        const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
        const writeService = new BoardWriteService(
            board,
            config,
            {} as WorktreeManager,
            events as unknown as EventLog,
            silentLogger as never,
            new CardJobs(config, db, broker as unknown as JobBroker),
            broker as unknown as JobBroker,
            new RunningCards(),
            {} as SettingsStore,
            new StaticStageConfigStore(stagesYaml),
        );

        const worktrees = {
            resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
            hasWork: vi.fn(async () => false),
            create: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
            resume: vi.fn(async () => {
                throw new Error('MARKER: should not resume — hasWork returned false');
            }),
            rebaseOntoHead: vi.fn(async () => {
                throw new Error('MARKER: should not rebase — the run is not resumable');
            }),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            // Card 0161: `run` now calls this unconditionally, once per board card, to grant read
            // access to every preserved patch — not just on a failure path.
            failedAttemptPatchPath: vi.fn((cardId: string) => `/tmp/run/cards/${cardId}/last-failed-attempt.patch`),
        };

        return { config, board, events, worktrees, writeService };
    };

    /** Captures what the agent adapter actually received, and what it could reach through the scope guard. */
    const buildDispatcher = (
        config: StaticBoardConfig,
        board: BoardRepository,
        events: { append: ReturnType<typeof vi.fn> },
        worktrees: unknown,
        probe: (input: AgentRunInput) => Promise<void>,
    ) => {
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (input: AgentRunInput): Promise<AgentRunOutput> => {
                await probe(input);
                return { result: { summary: 'did the thing' }, usage: { inputTokens: 10 }, truncated: false };
            },
        });

        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
        verifiers.set('testing', verifier);

        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        return new StageDispatcher(
            config as BoardConfig,
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

    it('dispatches normally on its very first run after approval and being advanced out of backlog, instead of poisoning on a wrong-stage refusal', async () => {
        const { config, board, events, worktrees, writeService } = await setUp();

        const approvedVersion = await board.currentVersion('0001');
        const approved = await writeService.approve('0001');
        expect(approved.stage).toBe('backlog');

        // The poller's second step (`advanceBacklogCard`), reproduced here with the same `move`
        // it is a thin wrapper over: a card already pinned on entry to `backlog` moves on to an
        // agent stage without touching the pin.
        const detail = await writeService.move('0001', { stage: 'testing' });
        expect(detail.stage).toBe('testing');

        // Reproduces the exact shape the bug report describes: the live card is in "testing" (where
        // the second move just sent it) while the version pinned onto it is the one from *before*
        // the approval write, whose own `frontmatter.stage` still reads "planning".
        const head = await board.read('0001');
        expect(head.frontmatter.stage).toBe('testing');
        expect(head.frontmatter.planVersionId).toBe(approvedVersion);
        const pinned = await board.readAt('0001', approvedVersion);
        expect(pinned.frontmatter.stage).toBe('planning');

        let scopedDecision: ScopeDecision | undefined;
        let editedDecision: ScopeDecision | undefined;
        let seenTitle: string | undefined;
        const dispatcher = buildDispatcher(config, board, events, worktrees, async input => {
            seenTitle = input.title;
            scopedDecision = await input.context.scope.check('src/a.ts');
            editedDecision = await input.context.scope.check('src/b.ts');
        });

        const result = await dispatcher.run('0001', 'testing');

        // The old bug: `assertDispatchable` compared the pinned snapshot's stage ("backlog") against
        // the stage being dispatched ("testing"), threw `NotDispatchableError { kind: 'wrong-stage' }`
        // immediately, and `CardStageJob` poisoned the card since `backlog` is not terminal. None of
        // that happens now — the run reaches the agent, passes, and advances the card.
        expect(result.passed).toBe(true);
        expect(result.transitionedTo).toBe('merged');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('merged');
        expect(stored.frontmatter.needsHuman).toBeFalsy();

        // The plan contract dispatched is the one pinned at approval, not whatever the live card
        // says: "Files in scope" only ever named src/a.ts.
        expect(seenTitle).toBe('do the thing');
        expect(scopedDecision).toMatchObject({ allowed: true, path: 'src/a.ts' });
        expect(editedDecision).toMatchObject({ allowed: false });
    });

    /**
     * The plan's own acceptance criterion: "an edit to the body after approval does not change
     * filesInScope or the materialized plan for a run already dispatched." Editing after approval
     * moves the live card further from the pinned snapshot without touching its stage — a stricter
     * version of the same head/card split, and the one `materializePlan` (which writes the plan file
     * the agent actually reads) has to get right too.
     */
    it('still dispatches the plan pinned at approval, not a body edited afterward, and does not widen scope', async () => {
        const { config, board, events, worktrees, writeService } = await setUp();
        await writeService.approve('0001');
        await writeService.move('0001', { stage: 'testing' });

        const editedBody = '## Goal\n\nDo it differently.\n\n## Files in scope\n\n- src/a.ts\n- src/b.ts\n';
        await board.write('0001', 'edit after approval', current => ({
            ...current,
            frontmatter: { ...current.frontmatter, title: 'a different title' },
            body: editedBody,
        }));

        const head = await board.read('0001');
        expect(head.frontmatter.stage).toBe('testing'); // unaffected by the body edit
        expect(head.frontmatter.title).toBe('a different title');
        expect(head.body).toBe(editedBody);

        let seenTitle: string | undefined;
        let widenedDecision: ScopeDecision | undefined;
        const dispatcher = buildDispatcher(config, board, events, worktrees, async input => {
            seenTitle = input.title;
            widenedDecision = await input.context.scope.check('src/b.ts');
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        // src/b.ts is only in scope on the edited, live body — the pinned plan never named it, so the
        // guard the agent actually ran against still refuses it.
        expect(widenedDecision).toMatchObject({ allowed: false });
        expect(seenTitle).toBe('do the thing');

        const materialized = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(materialized).toContain('src/a.ts');
        expect(materialized).not.toContain('src/b.ts');
        expect(materialized).not.toContain('a different title');
    });
});
