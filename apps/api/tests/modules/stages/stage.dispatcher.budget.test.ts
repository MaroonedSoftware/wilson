import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// A real board in the test database; isolation is a unique project per set-up. Stage config comes
// from a `StaticStageConfigStore` built from each test's YAML rather than a file under `boardRoot`.
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * A worktree layer that fails loudly the moment anything touches it. The over-budget path must
 * never reach any of these calls, so any call at all is a test failure, not just a wrong outcome —
 * a mock that silently no-ops would let a bug that dispatches anyway pass unnoticed.
 */
const untouchableWorktrees = () => ({
    resolveBranch: vi.fn(() => {
        throw new Error('MARKER: worktree touched');
    }),
    hasWork: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    resume: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    create: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    rebaseOntoHead: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    commit: vi.fn(async () => {
        throw new Error('MARKER: worktree touched');
    }),
    reclaim: vi.fn(async () => {}),
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
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
};

// onPass/onFail point at terminal states rather than other configured stages, so a single-stage
// file satisfies `assertRoutesResolve` (every route must resolve to a known stage or terminal
// state) without pulling in stages this card's behaviour has nothing to do with.
const stagesYamlWithCap = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
    maxCardInputTokens: 1000000
`;

const stagesYamlNoCap = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
`;

/**
 * Sets up a real board in the test database (as `stage.dispatcher.test.ts` already does for
 * `writeTransition`) with the given stage config YAML, and a `StageDispatcher` wired to an
 * `EventLog.totalInputTokens` stubbed to `spend` and a worktree layer that throws on first touch.
 */
const setUp = async (stagesYaml: string, spend: number, notifyWebhookUrl?: string, notifyBaseUrl?: string) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-budget-'));
    const boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'cards'), { recursive: true });
    const config = new StaticBoardConfig(
        uniqueProject(),
        boardRoot,
        join(base, 'code'),
        join(base, 'worktrees'),
        join(base, 'run'),
        notifyWebhookUrl,
        notifyBaseUrl,
    );
    const events = { append: vi.fn(async () => {}), totalInputTokens: vi.fn(async () => spend) };
    const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    await board.create(baseCard, 'initial');
    const worktrees = untouchableWorktrees();

    const dispatcher = new StageDispatcher(
        config,
        new StaticStageConfigStore(stagesYaml),
        board,
        worktrees as unknown as WorktreeManager,
        new StageAgentMap(),
        new StageVerifierMap(),
        new StageResultSchemaMap(),
        events as unknown as EventLog,
        silentLogger as never,
    );

    return { dispatcher, board, boardRoot, events, worktrees, project: config.project };
};

/**
 * Card 0018: a card that has already spent its configured `maxCardInputTokens` must be refused at
 * dispatch, before any worktree is cut — not discovered once the run has already spent more.
 */
describe('StageDispatcher.run refuses an over-budget card before touching the worktree', () => {
    it('refuses to dispatch once spend has reached the cap, and touches no worktree method at all', async () => {
        const { dispatcher, events, worktrees, project } = await setUp(stagesYamlWithCap, 1_000_000);

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        expect(result.transitionedTo).toBe('testing');
        expect(result.failures[0]).toMatch(/spent its budget/);
        expect(result.failures[0]).toMatch(/1000000/);

        expect(worktrees.resolveBranch).not.toHaveBeenCalled();
        expect(worktrees.hasWork).not.toHaveBeenCalled();
        expect(worktrees.create).not.toHaveBeenCalled();
        expect(worktrees.resume).not.toHaveBeenCalled();

        expect(events.totalInputTokens).toHaveBeenCalledWith(project, '0001');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'card.over-budget',
                payload: { spent: 1_000_000, cap: 1_000_000 },
            }),
        );
    });

    it('refuses once spend exceeds the cap, not only when it lands exactly on it', async () => {
        const { dispatcher, worktrees } = await setUp(stagesYamlWithCap, 5_000_000);

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        expect(worktrees.resolveBranch).not.toHaveBeenCalled();
    });

    it('writes the flag through the board, exactly as an exhausted kickback would, without moving the stage', async () => {
        const { dispatcher, board } = await setUp(stagesYamlWithCap, 5_000_000);

        await dispatcher.run('0001', 'testing');

        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.needsHumanReason).toMatch(/spent its budget/);
        // Retries are for work that came back wrong; this card never ran the stage at all.
        expect(stored.frontmatter.retries).toEqual({});

        const version = await board.currentVersion('0001');
        const row = await db.selectFrom('runner.cardVersions').select('message').where('id', '=', version!).executeTakeFirstOrThrow();
        expect(row.message).toBe('0001: testing flagged for a human (over budget)');
    });

    // Same atomicity constraint as the exhausted-kickback path: the flag is written through the
    // same writeWithEvent mutate a kickback exhaustion uses, so it must land as a single new
    // version, not a stage write followed by a separate flag write that could crash apart.
    it('writes the flag as a single new version, not a separate write from card creation', async () => {
        const { dispatcher, board } = await setUp(stagesYamlWithCap, 5_000_000);

        await dispatcher.run('0001', 'testing');

        const history = await board.versions('0001', 10);
        expect(history).toHaveLength(2); // card creation, then this one refusal

        const latest = await board.readAt('0001', history[0].id);
        expect(latest.frontmatter.stage).toBe('testing');
        expect(latest.frontmatter.needsHuman).toBe(true);
        expect(latest.frontmatter.needsHumanReason).toMatch(/spent its budget/);
    });

    it('does not reclaim any worktree, since a flagged card now keeps its tree rather than being terminal', async () => {
        const { dispatcher, worktrees, events } = await setUp(stagesYamlWithCap, 5_000_000);

        await dispatcher.run('0001', 'testing');

        expect(worktrees.reclaim).not.toHaveBeenCalled();
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
    });

    it('does not consult spend at all, and proceeds toward the worktree, when no cap is configured', async () => {
        const { dispatcher, events } = await setUp(stagesYamlNoCap, 10_000_000);

        // Absent `maxCardInputTokens` must behave exactly as it does today: unbounded. The dispatcher
        // reaches the worktree layer, which throws its marker error — proving the budget gate did not
        // short-circuit the run, since a refusal would have returned normally instead of throwing.
        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('MARKER: worktree touched');
        expect(events.totalInputTokens).not.toHaveBeenCalled();
    });

    it('does not refuse the card, and proceeds toward the worktree, when spend sits below the cap', async () => {
        const { dispatcher, events, project } = await setUp(stagesYamlWithCap, 500);

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('MARKER: worktree touched');
        expect(events.totalInputTokens).toHaveBeenCalledWith(project, '0001');
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'card.over-budget' }));
    });
});

/**
 * Card 0050: an over-budget refusal is the other route to the `needsHuman` moment (alongside an
 * exhausted kickback in `stage.dispatcher.test.ts`) — flagged before the stage ever runs rather than
 * after it fails. `fetch` is stubbed rather than `Notifier`, so the assertion is the HTTP call a
 * real webhook would see.
 */
describe('StageDispatcher.run notifies when it refuses an over-budget card (card 0050)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts a "needs-human" notification, with the over-budget reason and a deep link', async () => {
        fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const { dispatcher, project } = await setUp(stagesYamlWithCap, 5_000_000, 'https://hooks.example/notify', 'https://board.example');

        await dispatcher.run('0001', 'testing');

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
        expect(body.reason).toMatch(/spent its budget/);
    });

    it('makes no HTTP call when no webhook URL is configured', async () => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { dispatcher } = await setUp(stagesYamlWithCap, 5_000_000);

        await dispatcher.run('0001', 'testing');

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not notify when spend sits below the cap and the card is not refused at all', async () => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { dispatcher } = await setUp(stagesYamlWithCap, 500, 'https://hooks.example/notify');

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow('MARKER: worktree touched');

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not fail the refusal when the webhook itself fails', async () => {
        fetchMock = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });
        vi.stubGlobal('fetch', fetchMock);
        const { dispatcher, board } = await setUp(stagesYamlWithCap, 5_000_000, 'https://hooks.example/notify');

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(false);
        expect(result.needsHuman).toBe(true);
        const stored = await board.read('0001');
        expect(stored.frontmatter.needsHuman).toBe(true);
    });
});
