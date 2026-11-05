import { describe, expect, it, vi } from 'vitest';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import { StageConfigError } from '#modules/stages/stage.config.js';
import type { StageConfigStore } from '#modules/stages/stage.config.store.js';
import { NotDispatchableError, StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { StageAgentMap } from '#modules/agent/stage.agent.js';
import type { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';

/** A job held across a usage limit can fire after its lane was removed from the project's config. */
describe('StageDispatcher run, for a job naming a lane that no longer exists', () => {
    const run = (cardStage: string) => {
        const board = {
            read: vi.fn(async () => ({
                frontmatter: { id: '0001', title: 'a card', stage: cardStage, dependsOn: [], retries: {} },
                sections: {},
                body: '',
            })),
        };
        const stageConfigs = { load: vi.fn(async () => ({ stages: [{ name: 'testing' }] })) };
        return new StageDispatcher(
            { project: 'test' } as BoardConfig,
            stageConfigs as unknown as StageConfigStore,
            board as unknown as BoardRepository,
            {} as WorktreeManager,
            {} as StageAgentMap,
            {} as StageVerifierMap,
            {} as StageResultSchemaMap,
            {} as EventLog,
            { warn: vi.fn() } as never,
        ).run('0001', 'removed-lane');
    };

    it.each(['done', 'testing'])('calls the job stale when the card is now in "%s"', async stage => {
        const error = await run(stage).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(NotDispatchableError);
        expect((error as NotDispatchableError).reason).toEqual({ kind: 'wrong-stage', actualStage: stage });
    });

    it('still refuses a card sitting in the removed lane as a missing stage', async () => {
        const error = await run('removed-lane').catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('stage-not-found');
    });
});
