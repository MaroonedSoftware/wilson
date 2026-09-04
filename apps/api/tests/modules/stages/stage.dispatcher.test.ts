import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier, type VerificationOutcome } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { StageConfigStore } from '#modules/stages/stage.config.store.js';
import type { StageOutcome } from '#modules/stages/stage.result.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// The board is Postgres now, so these exercise a real database rather than a real git repo. One
// connection per file; isolation comes from a unique project per test, since cards are keyed by
// (project, id).
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
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.',
};

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    name: 'testing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'test the thing',
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
 * Exercises the transition-writing half of the dispatcher against a real board repo: an in-memory
 * mock of `BoardRepository.write` would only prove the test agrees with itself about what "write"
 * means, not that the card on disk actually moves.
 */
describe('StageDispatcher writeTransition (via private access — run() drags in the whole agent loop)', () => {
    let board: BoardRepository;
    let events: { append: ReturnType<typeof vi.fn> };
    let dispatcher: StageDispatcher;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-'));

        events = { append: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(baseCard, 'initial');

        dispatcher = new StageDispatcher(
            config as BoardConfig,
            {} as StageConfigStore,
            board,
            {} as WorktreeManager,
            {} as ModelRegistry,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            events as unknown as EventLog,
            silentLogger as never,
        );
    });

    // `head` and `card` are the same object in this suite unless a test says otherwise: these tests
    // are about the transition-writing logic itself, not the head/card split (card 0109), which has
    // its own dedicated group below.
    const writeTransition = (stage: StageConfig, card: Card, result: StageOutcome, head: Card = card) =>
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
        ).writeTransition('0001', 'testing', stage, head, card, result);

    it('advances a passing stage to onPass and leaves the body untouched', async () => {
        const stage = makeStage({ onPass: 'review' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('review');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('review');
        expect(stored.frontmatter.retries).toEqual({});
        expect(stored.body).toBe(baseCard.body);
    });

    it('kicks a failing stage back to onFail and bumps its retry counter', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('implementing');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.retries).toEqual({ testing: 1 });
        // A kickback with retries left behaves exactly as it does today: it routes to onFail,
        // unflagged. Only the maxKickbacks-th failure sets needsHuman.
        expect(stored.frontmatter.needsHuman).toBeFalsy();
    });

    it('sends a review that asks for revision backward even though the stage itself passed', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing', maxKickbacks: 3 });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const { target } = await writeTransition(
            stage,
            card,
            outcome({
                passed: true,
                result: {
                    verdict: 'revise',
                    findings: [{ severity: 'blocker', file: 'src/x.ts', line: 3, problem: 'wrong', suggestion: 'fix it' }],
                },
            }),
        );

        expect(target).toBe('implementing');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('implementing');
        expect(stored.frontmatter.retries).toEqual({ review: 1 });
        expect(stored.body).toContain('## Review findings');
        expect(stored.body).toContain('src/x.ts:3');
    });

    it('advances a clean review and does not fabricate a findings section', async () => {
        const stage = makeStage({ name: 'review', onPass: 'merge', onFail: 'implementing' });
        const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'review' } };

        const { target } = await writeTransition(stage, card, outcome({ passed: true, result: { verdict: 'pass', findings: [] } }));

        expect(target).toBe('merge');
        const stored = await board.read('0001');
        expect(stored.body).toBe(baseCard.body);
        expect(stored.body).not.toContain('Review findings');
    });

    it('records a transition.written event describing where the card came from and where it went', async () => {
        const stage = makeStage({ onPass: 'review' });

        await writeTransition(stage, baseCard, outcome({ passed: true }));

        // The second argument is the open transaction the card was moved in. Its presence is the
        // point: the event and the move commit together, so neither can survive without the other.
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'transition.written',
                payload: { from: 'testing', to: 'review', retries: {}, by: 'runner' },
            }),
            expect.anything(),
        );
    });

    it('records a version for the transition, not just the card\u2019s current state', async () => {
        const stage = makeStage({ onPass: 'review' });

        await writeTransition(stage, baseCard, outcome({ passed: true }));

        // The append-only half of the board: `runner.cards` says where the card is now, and this
        // says how it got there — what `git log` on the board repo used to answer.
        const version = await board.currentVersion('0001');
        const row = await db.selectFrom('runner.cardVersions').select('message').where('id', '=', version!).executeTakeFirstOrThrow();
        expect(row.message).toBe('0001: testing -> review');
    });

    it('stays on its own stage and flags the card once a kicked-back card exhausts its retries', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        const { target, needsHuman } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toContain('testing');
    });

    // The plan's constraint: "the flag and the transition commit together — both go into the same
    // writeWithEvent mutate". A bug that wrote the stage move and the flag as two separate
    // writeWithEvent calls would still converge to the same final board.read() above, but it would
    // leave two new versions in the history instead of one, and a crash between the two writes would
    // leave a card moved without ever being flagged — the exact failure the constraint rules out.
    it('records exactly one new version for the exhausted kickback, carrying the move and the flag together', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        await writeTransition(stage, baseCard, outcome({ passed: false }));

        const history = await board.versions('0001', 10);
        expect(history).toHaveLength(2); // card creation, then this one transition

        const latest = await board.readAt('0001', history[0].id);
        expect(latest.frontmatter.stage).toBe('testing');
        expect(latest.frontmatter.needsHuman).toBe(true);
        expect(latest.frontmatter.needsHumanReason).toContain('testing');
    });

    /**
     * Card 0109: `retries` is runner state, counted off `head`, not the plan-contract snapshot
     * pinned at approval. A card approved once and kicked back twice since carries its real attempt
     * count only on the live row — the pinned plan still shows whatever `retries` looked like at
     * approval time (here, empty). Counting from the pinned snapshot instead would forget every
     * attempt made after approval and let a card that has already exhausted its kickbacks keep
     * retrying for free.
     */
    it('counts a kickback off the live card’s retries, not the pinned plan’s', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });
        const pinned: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, retries: {} } };
        const head: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, retries: { testing: 2 } } };

        const { target, needsHuman } = await writeTransition(stage, pinned, outcome({ passed: false }), head);

        // Reading from `head` (2 prior attempts) reaches maxKickbacks (3) on this attempt and flags
        // the card. Reading from the pinned plan's empty `retries` would compute attempt 1 instead,
        // route to `implementing` unflagged, and grant a kickback the card already spent.
        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.retries).toEqual({ testing: 3 });
        expect(stored.frontmatter.needsHuman).toBe(true);
    });

    it('carries the live card’s retries forward on a pass, not the pinned plan’s', async () => {
        const stage = makeStage({ onPass: 'review' });
        const pinned: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, retries: {} } };
        const head: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, retries: { testing: 5 } } };

        const { target } = await writeTransition(stage, pinned, outcome({ passed: true }), head);

        expect(target).toBe('review');
        const stored = await board.read('0001');
        expect(stored.frontmatter.retries).toEqual({ testing: 5 });
    });

    /**
     * Card 0200: `InboundCardWriter` sets `sourceClosed` on the live card mid-run, while this stage
     * is still executing (see this card's Note). By the time the stage finishes and this method
     * runs, that flag must turn "advance" into "halt here instead" — one more stage, bounded by its
     * own budget, is what the card's Constraints allow, not a second one.
     */
    it('halts a passing stage at its own stage, flagged, when the card carries sourceClosed going in', async () => {
        const stage = makeStage({ onPass: 'review' });
        const closedHead: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, sourceClosed: true } };

        const { target, needsHuman } = await writeTransition(stage, baseCard, outcome({ passed: true }), closedHead);

        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toBe('source-closed');
    });

    it('halts a stage that would have kicked back at its own stage instead, when the card carries sourceClosed going in', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });
        const closedHead: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, sourceClosed: true } };

        const { target, needsHuman } = await writeTransition(stage, baseCard, outcome({ passed: false }), closedHead);

        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        // Not routed to `implementing`, and not merely flagged with the ordinary kickback-exhaustion
        // reason — the override replaces the target and the reason together.
        expect(stored.frontmatter.needsHumanReason).toBe('source-closed');
    });

    /**
     * The override must not replace a reason the ordinary decision already computed: an exhausted
     * kickback on a card that also happens to carry `sourceClosed` still reports why the kickback
     * itself failed, since that decision already flagged one (this card's Constraints: "when ... the
     * ordinary decision did not already flag one").
     */
    it('does not override an ordinary decision that already flags the card for its own reason', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });
        const closedHead: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, sourceClosed: true } };

        const { target, needsHuman } = await writeTransition(stage, baseCard, outcome({ passed: false }), closedHead);

        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.needsHumanReason).toContain('testing');
        expect(stored.frontmatter.needsHumanReason).not.toBe('source-closed');
    });
});

/**
 * Card 0050: an exhausted kickback is one of the three moments PROJECT.md's Notification section
 * names — `needsHuman` set for the first time. `fetch` is stubbed rather than `Notifier`, so what
 * is asserted is the observable HTTP call a real webhook would receive; the board write itself is
 * real (the same `PostgresBoardRepository` as `writeTransition` above), so the "fire after the
 * write, never inside it" constraint is checked by reading the board back from inside the stubbed
 * `fetch` call, not by asserting on call order against a mock.
 */
describe('StageDispatcher writeTransition notifies on an exhausted kickback (card 0050)', () => {
    let events: { append: ReturnType<typeof vi.fn> };
    let fetchMock: ReturnType<typeof vi.fn>;

    const buildDispatcher = async (notifyWebhookUrl?: string, notifyBaseUrl?: string) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-notify-'));

        events = { append: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(
            uniqueProject(),
            join(base, 'code'),
            join(base, 'worktrees'),
            join(base, 'run'),
            notifyWebhookUrl,
            notifyBaseUrl,
        );
        const boardRepo = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await boardRepo.create(baseCard, 'initial');

        const dispatcher = new StageDispatcher(
            config as BoardConfig,
            {} as StageConfigStore,
            boardRepo,
            {} as WorktreeManager,
            {} as ModelRegistry,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            events as unknown as EventLog,
            silentLogger as never,
        );
        return { dispatcher, boardRepo, project: config.project };
    };

    const writeTransition = (dispatcher: StageDispatcher, stage: StageConfig, card: Card, result: StageOutcome, head: Card = card) =>
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
        ).writeTransition('0001', 'testing', stage, head, card, result);

    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts a "needs-human" notification, with the reason and a deep link, once a kickback exhausts its retries', async () => {
        const { dispatcher, project } = await buildDispatcher('https://hooks.example/notify', 'https://board.example');
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        await writeTransition(dispatcher, stage, baseCard, outcome({ passed: false }));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({
            moment: 'needs-human',
            project,
            cardId: '0001',
            title: 'do the thing',
            stage: 'testing',
            url: 'https://board.example/cards/0001',
        });
        expect(body.reason).toContain('testing');
    });

    it('has already committed the flag to the board by the time the webhook is called', async () => {
        let sawFlagAtNotifyTime = false;
        const { dispatcher, boardRepo } = await buildDispatcher('https://hooks.example/notify');
        fetchMock.mockImplementation(async () => {
            const stored = await boardRepo.read('0001');
            sawFlagAtNotifyTime = stored.frontmatter.needsHuman === true;
            return new Response(null, { status: 200 });
        });
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        await writeTransition(dispatcher, stage, baseCard, outcome({ passed: false }));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sawFlagAtNotifyTime).toBe(true);
    });

    it('makes no HTTP call when no webhook URL is configured', async () => {
        const { dispatcher } = await buildDispatcher(undefined);
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        await writeTransition(dispatcher, stage, baseCard, outcome({ passed: false }));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not notify an ordinary kickback that still has retries left', async () => {
        const { dispatcher } = await buildDispatcher('https://hooks.example/notify');
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });

        await writeTransition(dispatcher, stage, baseCard, outcome({ passed: false }));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not notify a passing transition', async () => {
        const { dispatcher } = await buildDispatcher('https://hooks.example/notify');
        const stage = makeStage({ onPass: 'review' });

        await writeTransition(dispatcher, stage, baseCard, outcome({ passed: true }));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Do not send twice for one event: a card already flagged going into this run (a retried or
    // redelivered job reaching the same exhausted-kickback outcome again) has nothing new to report.
    it('does not re-notify a card that already carried needsHuman before this transition', async () => {
        const { dispatcher } = await buildDispatcher('https://hooks.example/notify');
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });
        const alreadyFlagged: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, needsHuman: true, needsHumanReason: 'already flagged' } };

        await writeTransition(dispatcher, stage, alreadyFlagged, outcome({ passed: false }));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Card 0109: `needsHuman` is runner state, read from `head`, not the pinned plan-contract
    // snapshot — a card flagged after its plan was approved must still be recognised as already
    // flagged here, even though the pinned `card` (frozen at approval, before the flag existed) says
    // otherwise.
    it('reads the already-flagged check off the live card, not a pinned plan snapshot that predates the flag', async () => {
        const { dispatcher } = await buildDispatcher('https://hooks.example/notify');
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });
        const flaggedHead: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, needsHuman: true, needsHumanReason: 'already flagged' } };

        await writeTransition(dispatcher, stage, baseCard, outcome({ passed: false }), flaggedHead);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not fail the transition when the webhook itself fails', async () => {
        const { dispatcher, boardRepo } = await buildDispatcher('https://hooks.example/notify');
        fetchMock.mockImplementation(async () => {
            throw new Error('ECONNREFUSED');
        });
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        const { target } = await writeTransition(dispatcher, stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('testing');
        const stored = await boardRepo.read('0001');
        expect(stored.frontmatter.needsHuman).toBe(true);
    });

    /**
     * Card 0200: the mid-run halt reuses this exact `needs-human` machinery rather than a second
     * notification path (this card's Constraints), so it gets the notify-once guard for free — this
     * checks it actually fires, once, with the reason the override sets.
     */
    it('notifies exactly once, with reason "source-closed", when a card whose source closed halts here', async () => {
        const { dispatcher, project } = await buildDispatcher('https://hooks.example/notify', 'https://board.example');
        const stage = makeStage({ onPass: 'review' });
        const closedHead: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, sourceClosed: true } };

        await writeTransition(dispatcher, stage, baseCard, outcome({ passed: true }), closedHead);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({
            moment: 'needs-human',
            project,
            cardId: '0001',
            stage: 'testing',
            reason: 'source-closed',
            url: 'https://board.example/cards/0001',
        });
    });
});

/**
 * Card 0016: a transition that lands a card on a terminal state must reclaim its worktree, and a
 * transition that does not must leave it alone — a parked or merely-kicked-back card still has work
 * resuming from it. `writeTransition` is exercised the same way as above, but this time `worktrees`
 * is a spy rather than `{}`, so the reclaim call (or its absence) is an observable result rather than
 * something inferred from the try/catch swallowing an error either way.
 */
describe('StageDispatcher writeTransition reclaims the worktree on a terminal transition', () => {
    let board: BoardRepository;
    let events: { append: ReturnType<typeof vi.fn> };
    let worktrees: { reclaim: ReturnType<typeof vi.fn> };
    let dispatcher: StageDispatcher;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-terminal-'));

        events = { append: vi.fn(async () => {}) };
        worktrees = { reclaim: vi.fn(async () => {}) };
        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(baseCard, 'initial');

        dispatcher = new StageDispatcher(
            config as BoardConfig,
            {} as StageConfigStore,
            board,
            worktrees as unknown as WorktreeManager,
            {} as ModelRegistry,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            events as unknown as EventLog,
            silentLogger as never,
        );
    });

    const writeTransition = (stage: StageConfig, card: Card, result: StageOutcome, head: Card = card) =>
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
        ).writeTransition('0001', 'testing', stage, head, card, result);

    it('reclaims the card’s worktree and records worktree.reclaimed when the target is merged', async () => {
        const stage = makeStage({ onPass: 'merged' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('merged');
        expect(worktrees.reclaim).toHaveBeenCalledTimes(1);
        expect(worktrees.reclaim).toHaveBeenCalledWith('0001');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'worktree.reclaimed',
                payload: { cardId: '0001', target: 'merged' },
            }),
        );
    });

    it('does not reclaim when a stage exhausts its retries and flags the card, since the target is no longer terminal', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 1 });

        const { target, needsHuman } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('testing');
        expect(needsHuman).toBe(true);
        expect(worktrees.reclaim).not.toHaveBeenCalled();
    });

    it('does not reclaim when the card advances to an ordinary, non-terminal stage', async () => {
        const stage = makeStage({ onPass: 'review' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('review');
        expect(worktrees.reclaim).not.toHaveBeenCalled();
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });

    it('does not reclaim when a kickback still has retries left, leaving the branch resumable', async () => {
        const stage = makeStage({ onFail: 'implementing', maxKickbacks: 3 });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: false }));

        expect(target).toBe('implementing');
        expect(worktrees.reclaim).not.toHaveBeenCalled();
    });

    it('lets the transition stand and does not append worktree.reclaimed when reclaim itself fails', async () => {
        worktrees.reclaim.mockRejectedValueOnce(new Error('boom: directory busy'));
        const stage = makeStage({ onPass: 'dropped' });

        const { target } = await writeTransition(stage, baseCard, outcome({ passed: true }));

        expect(target).toBe('dropped');
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('dropped');
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });
});

/**
 * Card 0015: both adapters compute a `budgetFailure` string when a run's input tokens meet the
 * stage's cap, but that value only matters if the dispatcher actually reads it. A review of this
 * card's own implementation caught exactly that gap — `run.budgetFailure` was returned by the
 * adapters and typed on `AgentRunOutput`, but nothing in `StageDispatcher` ever looked at it, so an
 * over-budget run could still pass because the generic "no report" and truncation checks are the
 * only things that fire.
 *
 * `runAgent` (private) is exercised directly, the same way `writeTransition` is above, with a fake
 * adapter and verifier standing in for a real agent run — the point here is what the dispatcher does
 * with `run.budgetFailure`, not the agent loop that produced it.
 */
describe('StageDispatcher runAgent (via private access) surfaces a run’s budgetFailure', () => {
    const stage = makeStage({ adapter: 'api' as never, verifier: 'testing' });
    const card: Card = { ...baseCard, frontmatter: { ...baseCard.frontmatter, stage: 'testing' } };
    const scope = new ScopeGuard({ worktreeRoot: '/tmp/worktree', allow: ['**'], alwaysAllowed: [] });
    const worktree = { path: '/tmp/worktree', baseSha: 'deadbeef' } as unknown as Awaited<ReturnType<WorktreeManager['create']>>;
    const stages = { scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages: [stage] };

    const buildDispatcher = (adapterOutput: AgentRunOutput, verifierOutcome: VerificationOutcome) => {
        const agents = new StageAgentMap();
        agents.set('api', { run: async () => adapterOutput });
        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => verifierOutcome };
        verifiers.set('testing', verifier);
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        return new StageDispatcher(
            { project: 'test' } as BoardConfig,
            {} as StageConfigStore,
            {} as BoardRepository,
            {} as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            {} as EventLog,
            silentLogger as never,
        );
    };

    const runAgent = (dispatcher: StageDispatcher) =>
        (
            dispatcher as unknown as {
                runAgent(input: {
                    card: Card;
                    stage: StageConfig;
                    worktree: typeof worktree;
                    scope: ScopeGuard;
                    planPath: string;
                    stages: typeof stages;
                }): Promise<StageOutcome>;
            }
        ).runAgent({ card, stage, worktree, scope, planPath: '/run/plan.md', stages });

    it('fails the stage on a budgetFailure even though the verifier itself passed', async () => {
        const dispatcher = buildDispatcher(
            {
                result: { summary: 'did the thing' },
                usage: { inputTokens: 5000 },
                truncated: false,
                budgetFailure: 'input token budget exceeded: used 5000, cap 1000',
            },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('input token budget exceeded: used 5000, cap 1000');
    });

    it('leaves a passing outcome alone when the run reports no budgetFailure', async () => {
        const dispatcher = buildDispatcher(
            { result: { summary: 'did the thing' }, usage: { inputTokens: 500 }, truncated: false },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(true);
        expect(result.failures).toEqual([]);
    });

    // A wall-clock or token-budget cutoff reports `truncated: true` alongside its `budgetFailure`,
    // same as ordinary step exhaustion does with `truncated: true` alone. The review's blocker was
    // that both landed together as `truncated: true` with no way to tell them apart, so the generic
    // "used all N of its steps" message was reported even when the real cause was a timeout after a
    // handful of steps. The fix — `run.truncated && !run.budgetFailure` in the dispatcher — has to be
    // checked from both sides: the step message must disappear once a budgetFailure explains the cut
    // off, and it must still appear when nothing more specific is known.
    it('reports only the budgetFailure, not the generic step-exhaustion message, when a run is both truncated and over budget', async () => {
        const dispatcher = buildDispatcher(
            {
                result: undefined,
                usage: { inputTokens: 10 },
                truncated: true,
                budgetFailure: 'wall-clock budget exceeded: cap 1800000ms',
            },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('wall-clock budget exceeded: cap 1800000ms');
        expect(result.failures.some(f => f.includes('used all'))).toBe(false);
    });

    it('still reports the generic step-exhaustion message when a run is truncated with no more specific cause known', async () => {
        const dispatcher = buildDispatcher(
            { result: undefined, usage: { inputTokens: 10 }, truncated: true },
            { passed: true, failures: [], changedPaths: [] },
        );

        const result = await runAgent(dispatcher);

        expect(result.passed).toBe(false);
        expect(result.failures.some(f => f.includes(`used all ${stage.maxSteps} of its steps`))).toBe(true);
    });

    // Card 0024: `AgentRunInput.baseSha` is what lets a stage's prompt name the sha a `git diff`
    // must be run against to reproduce the card's whole diff. `runAgent` is the one place that reads
    // `worktree.baseSha` off the worktree it already holds and hands it to the adapter — a value the
    // adapter has no other way to learn, since `ToolContext` deliberately stays narrow and carries
    // no git state at all.
    it("passes worktree.baseSha through to the adapter as the run input's baseSha", async () => {
        let receivedBaseSha: string | undefined;
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async input => {
                receivedBaseSha = input.baseSha;
                return { result: { summary: 'did the thing' }, usage: { inputTokens: 10 }, truncated: false };
            },
        });
        const verifiers = new StageVerifierMap();
        verifiers.set('testing', { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) });
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        const dispatcher = new StageDispatcher(
            { project: 'test' } as BoardConfig,
            {} as StageConfigStore,
            {} as BoardRepository,
            {} as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            {} as EventLog,
            silentLogger as never,
        );

        await runAgent(dispatcher);

        expect(receivedBaseSha).toBe(worktree.baseSha);
    });

    /**
     * Card 0164: `scopeViolationPolicy` on the `ToolContext` used to be `stages.scopeViolation`
     * alone — the project-wide value, unconditionally. It is now `stage.scopeViolation ??
     * stages.scopeViolation`, so a stage can override the project's default for itself without
     * touching any other stage. `runAgent` is exercised directly (as above) with a fake adapter that
     * captures the `ToolContext` it was actually handed — the point is what the dispatcher resolves,
     * not anything the adapter or the scope tool does with it.
     */
    describe('resolves scopeViolationPolicy per stage (card 0164)', () => {
        const buildDispatcherCapturingContext = () => {
            let capturedPolicy: string | undefined;
            const agents = new StageAgentMap();
            agents.set('api', {
                run: async input => {
                    capturedPolicy = input.context.scopeViolationPolicy;
                    return { result: { summary: 'did the thing' }, usage: { inputTokens: 10 }, truncated: false };
                },
            });
            const verifiers = new StageVerifierMap();
            verifiers.set('testing', { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) });
            const resultSchemas = new StageResultSchemaMap();
            resultSchemas.set('testing', {} as never);

            const dispatcher = new StageDispatcher(
                { project: 'test' } as BoardConfig,
                {} as StageConfigStore,
                {} as BoardRepository,
                {} as WorktreeManager,
                agents,
                verifiers,
                resultSchemas,
                {} as EventLog,
                silentLogger as never,
            );
            return { dispatcher, getPolicy: () => capturedPolicy };
        };

        it("uses the stage's own scopeViolation when it sets one, even though the project default disagrees", async () => {
            const { dispatcher, getPolicy } = buildDispatcherCapturingContext();
            const strictStage = makeStage({ adapter: 'api' as never, verifier: 'testing', scopeViolation: 'kickback' });
            const permissiveProjectStages = { scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages: [strictStage] };

            await (
                dispatcher as unknown as {
                    runAgent(input: {
                        card: Card;
                        stage: StageConfig;
                        worktree: typeof worktree;
                        scope: ScopeGuard;
                        planPath: string;
                        stages: typeof permissiveProjectStages;
                    }): Promise<StageOutcome>;
                }
            ).runAgent({ card, stage: strictStage, worktree, scope, planPath: '/run/plan.md', stages: permissiveProjectStages });

            expect(getPolicy()).toBe('kickback');
        });

        it('falls back to the project-wide value when the stage sets nothing — the pre-card-0164 behaviour', async () => {
            const { dispatcher, getPolicy } = buildDispatcherCapturingContext();
            const defaultStage = makeStage({ adapter: 'api' as never, verifier: 'testing' });
            const strictProjectStages = { scopeViolation: 'kickback' as const, alwaysAllowed: [], deny: [], stages: [defaultStage] };

            await (
                dispatcher as unknown as {
                    runAgent(input: {
                        card: Card;
                        stage: StageConfig;
                        worktree: typeof worktree;
                        scope: ScopeGuard;
                        planPath: string;
                        stages: typeof strictProjectStages;
                    }): Promise<StageOutcome>;
                }
            ).runAgent({ card, stage: defaultStage, worktree, scope, planPath: '/run/plan.md', stages: strictProjectStages });

            expect(getPolicy()).toBe('kickback');
        });

        it('leaves one stage widening while a sibling stage in the same project kicks back', async () => {
            const strictStage = makeStage({ name: 'implementing', adapter: 'api' as never, verifier: 'testing', scopeViolation: 'kickback' });
            const permissiveStage = makeStage({ name: 'testing', adapter: 'api' as never, verifier: 'testing' });
            const projectStages = { scopeViolation: 'widen' as const, alwaysAllowed: [], deny: [], stages: [strictStage, permissiveStage] };

            const strict = buildDispatcherCapturingContext();
            await (
                strict.dispatcher as unknown as {
                    runAgent(input: {
                        card: Card;
                        stage: StageConfig;
                        worktree: typeof worktree;
                        scope: ScopeGuard;
                        planPath: string;
                        stages: typeof projectStages;
                    }): Promise<StageOutcome>;
                }
            ).runAgent({ card, stage: strictStage, worktree, scope, planPath: '/run/plan.md', stages: projectStages });

            const permissive = buildDispatcherCapturingContext();
            await (
                permissive.dispatcher as unknown as {
                    runAgent(input: {
                        card: Card;
                        stage: StageConfig;
                        worktree: typeof worktree;
                        scope: ScopeGuard;
                        planPath: string;
                        stages: typeof projectStages;
                    }): Promise<StageOutcome>;
                }
            ).runAgent({ card, stage: permissiveStage, worktree, scope, planPath: '/run/plan.md', stages: projectStages });

            expect(strict.getPolicy()).toBe('kickback');
            expect(permissive.getPolicy()).toBe('widen');
        });
    });
});
