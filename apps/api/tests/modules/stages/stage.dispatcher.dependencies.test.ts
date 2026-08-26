import { describe, expect, it } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { ModelRegistry } from '#modules/agent/model.registry.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';
import type { StageConfig } from '#modules/stages/stage.config.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const card = (id: string, stage: string, dependsOn: string[] = []): Card => ({
    frontmatter: {
        id,
        title: `Card ${id}`,
        stage,
        dependsOn,
        retries: {},
    } as CardFrontmatter,
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Files in scope\n\n- src/x.ts',
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
 * Card 0023: `assertDispatchable` used to refuse any card with a non-empty `dependsOn`
 * unconditionally — "dependency checking lands with the queue at step 3" — which meant a card whose
 * dependency had already merged was refused exactly as hard as one whose dependency had never
 * started. It now asks the real question via `unsatisfiedDependencies`, the same resolver `nextCard`
 * and `card list` use, so these three must agree.
 *
 * `assertDispatchable` is private and synchronous; exercised the same way `writeTransition` and
 * `runAgent` are in stage.dispatcher.test.ts — via a cast to a narrow interface — since a full `run()`
 * would drag in the worktree manager, an agent adapter and a verifier that have nothing to do with
 * this gate.
 */
describe('StageDispatcher assertDispatchable dependency gate', () => {
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

    const assertDispatchable = (dispatcher: StageDispatcher, target: Card, cards: Card[]) =>
        (
            dispatcher as unknown as {
                assertDispatchable(head: Card, card: Card, stage: StageConfig, cards: Card[]): void;
            }
            // `head` and `card` are the same object here: this suite is about `unsatisfiedDependencies`
            // agreeing with `nextCard`/`card list`, not about the head/card split itself — that split is
            // covered directly in stage.dispatcher.not-dispatchable.test.ts (card 0109).
        ).assertDispatchable(target, target, stage, cards);

    it('dispatches a card with no dependencies', () => {
        const target = card('0001', 'testing');

        expect(() => assertDispatchable(buildDispatcher(), target, [target])).not.toThrow();
    });

    it('dispatches a card whose only dependency has merged', () => {
        const dependency = card('0001', 'merged');
        const target = card('0002', 'testing', ['0001']);

        expect(() => assertDispatchable(buildDispatcher(), target, [dependency, target])).not.toThrow();
    });

    it('refuses a card whose dependency exists but has not merged, naming it and saying it is waiting', () => {
        const dependency = card('0001', 'implementing');
        const target = card('0002', 'testing', ['0001']);

        expect(() => assertDispatchable(buildDispatcher(), target, [dependency, target])).toThrow('card 0002 is waiting on 0001');
    });

    it('refuses a card whose dependency is absent from the board entirely, the same as one that has not finished', () => {
        const target = card('0002', 'testing', ['9999']);

        expect(() => assertDispatchable(buildDispatcher(), target, [target])).toThrow('card 0002 is waiting on 9999');
    });

    it('names only the outstanding dependencies when a card has a mix of merged and unmerged', () => {
        const merged = card('0001', 'merged');
        const target = card('0003', 'testing', ['0001', '0002']);

        expect(() => assertDispatchable(buildDispatcher(), target, [merged, target])).toThrow('card 0003 is waiting on 0002');
    });

    it('never refuses on the old blanket message, now that a satisfied dependency does not block', () => {
        const dependency = card('0001', 'merged');
        const target = card('0002', 'testing', ['0001']);

        expect(() => assertDispatchable(buildDispatcher(), target, [dependency, target])).not.toThrow(
            'dependency checking lands with the queue at step 3',
        );
    });

    it('still refuses a card that is not actually in the stage being dispatched, dependency gate aside', () => {
        const target = card('0002', 'implementing');

        expect(() => assertDispatchable(buildDispatcher(), target, [target])).toThrow('is in stage "implementing", not "testing"');
    });
});
