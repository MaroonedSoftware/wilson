import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { AutoSplitter } from '#modules/board/auto.splitter.js';
import { StaticBoardConfig, type BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import type { StageAgentMap } from '#modules/agent/stage.agent.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { StageConfigStore } from '#modules/stages/stage.config.store.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageOutcome, StageResultSchemaMap, SupportedRefusal } from '#modules/stages/stage.result.js';
import type { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const baseCard: Card = {
    frontmatter: { id: '0001', title: 'too big', stage: 'scope-check', dependsOn: [], retries: {} },
    sections: {},
    body: '## Goal\n\nDo it all.',
};

const stage = {
    name: 'scope-check',
    mode: 'agent',
    onPass: 'implementing',
    onFail: 'planning',
    maxKickbacks: 3,
} as StageConfig;

const refusal: SupportedRefusal = {
    reason: 'too wide',
    division: [
        { title: 'a', tasks: ['1'], delivers: 'a', dependsOn: [] },
        { title: 'b', tasks: ['2'], delivers: 'b', dependsOn: [] },
    ],
};

const refused = (overrides: Partial<StageOutcome> = {}): StageOutcome => ({
    passed: false,
    failures: ['refusing: too wide'],
    changedPaths: [],
    scopeGrants: [],
    supportedRefusal: refusal,
    ...overrides,
});

describe('StageDispatcher auto-split routing', () => {
    let board: BoardRepository;
    let split: ReturnType<typeof vi.fn>;
    let reclaim: ReturnType<typeof vi.fn>;

    const dispatcher = (autoSplitter?: AutoSplitter) =>
        new StageDispatcher(
            config,
            {} as StageConfigStore,
            board,
            { failedAttemptPatchPath: (id: string) => `/tmp/${id}.patch`, reclaim } as unknown as WorktreeManager,
            {} as StageAgentMap,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            { append: vi.fn(async () => {}) } as unknown as EventLog,
            silentLogger as never,
            undefined,
            undefined,
            undefined,
            undefined,
            autoSplitter,
        );

    const transition = (subject: StageDispatcher, outcome: StageOutcome, head: Card = baseCard) =>
        (
            subject as unknown as {
                writeTransition(
                    cardId: string,
                    stageName: string,
                    stage: StageConfig,
                    head: Card,
                    card: Card,
                    outcome: StageOutcome,
                ): Promise<{ target: string; needsHuman: boolean }>;
            }
        ).writeTransition('0001', 'scope-check', stage, head, head, outcome);

    let config: BoardConfig;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-auto-split-'));
        config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        board = new PostgresBoardRepository(config, db, { append: vi.fn(async () => {}) } as unknown as EventLog);
        await board.create(baseCard, 'initial');
        split = vi.fn();
        reclaim = vi.fn(async () => {});
    });

    it('takes the split instead of the kickback when the splitter acts', async () => {
        split.mockResolvedValue({ pieceIds: ['0002', '0003'] });

        const result = await transition(dispatcher({ split } as unknown as AutoSplitter), refused());

        expect(split).toHaveBeenCalledWith('0001', 'scope-check', refusal);
        expect(result).toEqual({ target: 'split', needsHuman: false, splitInto: ['0002', '0003'] });
        // The fake split wrote nothing, and this proves the kickback did not write either.
        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('scope-check');
        expect(stored.frontmatter.retries).toEqual({});
    });

    it('names no pieces to draft when another run of the stage already split the card', async () => {
        split.mockResolvedValue({ pieceIds: [] });

        const result = await transition(dispatcher({ split } as unknown as AutoSplitter), refused());

        expect(result).toEqual({ target: 'split', needsHuman: false });
    });

    it('routes to planning, as it always has, when the splitter declines', async () => {
        split.mockResolvedValue(undefined);

        const result = await transition(dispatcher({ split } as unknown as AutoSplitter), refused());

        expect(result.target).toBe('planning');
        expect((await board.read('0001')).frontmatter.stage).toBe('planning');
    });

    it('routes to planning with no splitter wired', async () => {
        expect((await transition(dispatcher(), refused())).target).toBe('planning');
    });

    it('does not ask the splitter about a failure with no supported refusal', async () => {
        await transition(dispatcher({ split } as unknown as AutoSplitter), refused({ supportedRefusal: undefined }));

        expect(split).not.toHaveBeenCalled();
    });

    it('leaves a card whose ticket closed mid-run to the source-closed halt', async () => {
        const head = { ...baseCard, frontmatter: { ...baseCard.frontmatter, sourceClosed: true } };

        const result = await transition(dispatcher({ split } as unknown as AutoSplitter), refused(), head);

        expect(split).not.toHaveBeenCalled();
        expect(result).toEqual({ target: 'scope-check', needsHuman: true });
    });

    it('carries the verifier’s supported refusal out of a finished run, and drops it from a truncated one', async () => {
        const verification = { passed: false, failures: ['refusing: too wide'], changedPaths: [], supportedRefusal: refusal };
        const runWith = (run: Record<string, unknown>) =>
            (
                new StageDispatcher(
                    config,
                    {} as StageConfigStore,
                    board,
                    {} as WorktreeManager,
                    new Map([['cli', { run: async () => run }]]) as unknown as StageAgentMap,
                    new Map([['scope-check', { verify: async () => verification }]]) as unknown as StageVerifierMap,
                    new Map([['scope-check', {}]]) as unknown as StageResultSchemaMap,
                    { append: vi.fn(async () => {}) } as unknown as EventLog,
                    silentLogger as never,
                ) as unknown as { runAgent(input: unknown): Promise<StageOutcome> }
            ).runAgent({
                card: baseCard,
                stage: { ...stage, adapter: 'cli', allowedCommands: [], maxSteps: 10 },
                worktree: { path: '/tmp/x', baseSha: 'abc' },
                scope: { grants: () => [] },
                planPath: '/tmp/plan.md',
                stages: {},
            });

        const finished = await runWith({ result: {}, usage: {} });
        expect(finished.supportedRefusal).toEqual(refusal);

        const truncated = await runWith({ result: {}, usage: {}, truncated: true });
        expect(truncated.supportedRefusal).toBeUndefined();
    });
});
