import { describe, expect, it } from 'vitest';
import { NotDispatchableError, StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const card = (id: string, stage: string, overrides: Partial<Card> = {}): Card => ({
    frontmatter: {
        id,
        title: `Card ${id}`,
        stage,
        dependsOn: [],
        retries: {},
    } as CardFrontmatter,
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Files in scope\n\n- src/x.ts',
    ...overrides,
});

const stage: StageConfig = {
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
};

/**
 * Card 0044: `assertDispatchable`'s three refusals used to be bare `new Error`s, indistinguishable
 * from a provider hiccup except by parsing the message. `CardStageJob` now routes on a discriminant
 * instead, so this pins down the discriminant itself — that it is a `NotDispatchableError`, and
 * that `reason.kind` is the one the job actually branches on for each of the three conditions.
 *
 * Exercised the same way `stage.dispatcher.dependencies.test.ts` does: `assertDispatchable` is
 * private and synchronous, reached via a cast to a narrow interface so a full `run()` does not have
 * to drag in the worktree manager, an agent adapter and a verifier that have nothing to do with this
 * gate.
 */
describe('StageDispatcher assertDispatchable — NotDispatchableError discriminant', () => {
    const buildDispatcher = () =>
        new StageDispatcher(
            { project: 'test' } as BoardConfig,
            {} as BoardRepository,
            {} as WorktreeManager,
            new StageAgentMap(),
            new StageVerifierMap(),
            new StageResultSchemaMap(),
            {} as EventLog,
            silentLogger as never,
        );

    const assertDispatchable = (target: Card, cards: Card[]) =>
        (
            buildDispatcher() as unknown as {
                assertDispatchable(card: Card, stage: StageConfig, cards: Card[]): void;
            }
        ).assertDispatchable(target, stage, cards);

    const capture = (target: Card, cards: Card[]): NotDispatchableError => {
        try {
            assertDispatchable(target, cards);
        } catch (error) {
            expect(error).toBeInstanceOf(NotDispatchableError);
            return error as NotDispatchableError;
        }
        throw new Error('assertDispatchable did not throw');
    };

    it('carries kind "wrong-stage" when the card is not in the stage being dispatched', () => {
        const target = card('0002', 'implementing');

        const error = capture(target, [target]);

        expect(error.reason.kind).toBe('wrong-stage');
    });

    it('carries kind "empty-scope" when the card has no "Files in scope"', () => {
        const target = card('0002', 'testing', { sections: {}, body: '## Goal\n\nDo the thing.' });

        const error = capture(target, [target]);

        expect(error.reason.kind).toBe('empty-scope');
    });

    it('carries kind "unsatisfied-dependency" and the outstanding ids when a dependency has not merged', () => {
        const dependency = card('0001', 'implementing');
        const target = card('0002', 'testing');
        target.frontmatter.dependsOn = ['0001'];

        const error = capture(target, [dependency, target]);

        expect(error.reason.kind).toBe('unsatisfied-dependency');
        expect(error.reason.kind === 'unsatisfied-dependency' && error.reason.outstanding).toEqual(['0001']);
    });

    it('is not a NotDispatchableError for a dispatchable card — nothing is thrown at all', () => {
        const target = card('0001', 'testing');

        expect(() => assertDispatchable(target, [target])).not.toThrow();
    });
});
