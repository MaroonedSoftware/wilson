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
import { stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import type { StageConfigStore } from '#modules/stages/stage.config.store.js';

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
    ...stageDefaults,
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
 * Card 0044: `assertDispatchable`'s refusals used to be bare `new Error`s, indistinguishable from a
 * provider hiccup except by parsing the message. `CardStageJob` now routes on a discriminant
 * instead, so this pins down the discriminant itself — that it is a `NotDispatchableError`, and that
 * `reason.kind` is the one the job actually branches on for each condition.
 *
 * Card 0109 split `assertDispatchable` into two reads: `head` (the live row — stage, needsHuman,
 * dependsOn) and `card` (the plan contract pinned at approval — "Files in scope" only). Most cases
 * below pass the same object for both, the way a card with no approved plan version does (`card ===
 * head` in `run()`); a dedicated group further down passes them apart to prove each check reads the
 * one it is supposed to, not the other.
 */
describe('StageDispatcher assertDispatchable — NotDispatchableError discriminant', () => {
    const buildDispatcher = () =>
        new StageDispatcher(
            { project: 'test' } as BoardConfig,
            {} as StageConfigStore,
            {} as BoardRepository,
            {} as WorktreeManager,
            new StageAgentMap(),
            new StageVerifierMap(),
            new StageResultSchemaMap(),
            {} as EventLog,
            silentLogger as never,
        );

    const assertDispatchable = (head: Card, planCard: Card, cards: Card[]) =>
        (
            buildDispatcher() as unknown as {
                assertDispatchable(head: Card, card: Card, stage: StageConfig, cards: Card[]): void;
            }
        ).assertDispatchable(head, planCard, stage, cards);

    const capture = (head: Card, planCard: Card, cards: Card[]): NotDispatchableError => {
        try {
            assertDispatchable(head, planCard, cards);
        } catch (error) {
            expect(error).toBeInstanceOf(NotDispatchableError);
            return error as NotDispatchableError;
        }
        throw new Error('assertDispatchable did not throw');
    };

    it('carries kind "wrong-stage" when the card is not in the stage being dispatched', () => {
        const target = card('0002', 'implementing');

        const error = capture(target, target, [target]);

        expect(error.reason.kind).toBe('wrong-stage');
    });

    /**
     * Card 0084: `wrong-stage` now carries the card's actual stage alongside the discriminant, so
     * `CardStageJob` can tell a card genuinely misplaced (card 0044's bug) from a stale job arriving
     * after the card already reached a terminal stage — without that field it would have nothing to
     * call `isTerminal` on.
     */
    it('carries the card\'s actual stage on a "wrong-stage" refusal', () => {
        const target = card('0002', 'merged');

        const error = capture(target, target, [target]);

        expect(error.reason.kind).toBe('wrong-stage');
        expect(error.reason.kind === 'wrong-stage' && error.reason.actualStage).toBe('merged');
    });

    it('carries kind "empty-scope" when the card has no "Files in scope"', () => {
        const target = card('0002', 'testing', { sections: {}, body: '## Goal\n\nDo the thing.' });

        const error = capture(target, target, [target]);

        expect(error.reason.kind).toBe('empty-scope');
    });

    it('carries kind "unsatisfied-dependency" and the outstanding ids when a dependency has not merged', () => {
        const dependency = card('0001', 'implementing');
        const target = card('0002', 'testing');
        target.frontmatter.dependsOn = ['0001'];

        const error = capture(target, target, [dependency, target]);

        expect(error.reason.kind).toBe('unsatisfied-dependency');
        expect(error.reason.kind === 'unsatisfied-dependency' && error.reason.outstanding).toEqual(['0001']);
    });

    it('is not a NotDispatchableError for a dispatchable card — nothing is thrown at all', () => {
        const target = card('0001', 'testing');

        expect(() => assertDispatchable(target, target, [target])).not.toThrow();
    });

    /**
     * Card 0109: a card can be flagged for a human while sitting in any stage, so this is checked
     * first and on its own, the same way `whyNotDispatchable` (jobs/dispatchable.ts) checks it before
     * enqueuing at all — a card whose plan was approved and then flagged must still be refused, not
     * dispatched.
     */
    it('carries kind "needs-human" when the live card is flagged, even though it is otherwise perfectly dispatchable', () => {
        const target = card('0001', 'testing', { frontmatter: { ...card('0001', 'testing').frontmatter, needsHuman: true } });

        const error = capture(target, target, [target]);

        expect(error.reason.kind).toBe('needs-human');
        expect(error.message).toContain('0001');
        expect(error.message).toMatch(/flagged for a human/);
    });

    it('refuses on "needs-human" even when the card is also in the wrong stage — the flag is checked first', () => {
        const target = card('0001', 'implementing', { frontmatter: { ...card('0001', 'implementing').frontmatter, needsHuman: true } });

        const error = capture(target, target, [target]);

        expect(error.reason.kind).toBe('needs-human');
    });

    /**
     * Card 0109's actual bug, reproduced directly at the unit level: `BoardWriteService.approve`
     * pins the version *before* the approval writes the card's new stage, so a pinned snapshot's own
     * `frontmatter.stage` is always the stage the card left (`backlog`), never the one it is running
     * in. The old code checked the pinned snapshot's stage instead of the live one and refused every
     * approved card on its very next dispatch. Here `head` (live) is in "testing" — the stage being
     * dispatched — while `card` (the pinned plan) still says "backlog", exactly as it would the
     * moment after `approve()` runs. This must not throw at all.
     */
    describe('the head/card split (card 0109)', () => {
        it('dispatches normally when the pinned plan\'s stage differs from the live card\'s stage', () => {
            const head = card('0001', 'testing');
            const pinned = card('0001', 'backlog');

            expect(() => assertDispatchable(head, pinned, [head])).not.toThrow();
        });

        it('still refuses on "wrong-stage" using the live stage, even when the pinned plan happens to agree with the stage being dispatched', () => {
            const head = card('0001', 'implementing');
            const pinned = card('0001', 'testing');

            const error = capture(head, pinned, [head]);

            expect(error.reason.kind).toBe('wrong-stage');
            expect(error.reason.kind === 'wrong-stage' && error.reason.actualStage).toBe('implementing');
        });

        it('reads dependsOn from the live card, not the pinned plan', () => {
            const dependency = card('0002', 'implementing');
            const head = card('0001', 'testing');
            head.frontmatter.dependsOn = ['0002'];
            const pinned = card('0001', 'testing');
            pinned.frontmatter.dependsOn = [];

            const error = capture(head, pinned, [dependency, head]);

            expect(error.reason.kind).toBe('unsatisfied-dependency');
        });

        it('does not block on a dependency that only the pinned plan names', () => {
            const dependency = card('0002', 'implementing');
            const head = card('0001', 'testing');
            head.frontmatter.dependsOn = [];
            const pinned = card('0001', 'testing');
            pinned.frontmatter.dependsOn = ['0002'];

            expect(() => assertDispatchable(head, pinned, [dependency, head])).not.toThrow();
        });

        it('reads "Files in scope" from the pinned plan, not the live card', () => {
            const head = card('0001', 'testing');
            const pinned = card('0001', 'testing', { sections: {}, body: '## Goal\n\nDo the thing.' });

            const error = capture(head, pinned, [head]);

            expect(error.reason.kind).toBe('empty-scope');
        });

        it('does not refuse on an empty scope that only the live card happens to have', () => {
            const head = card('0001', 'testing', { sections: {}, body: '## Goal\n\nDo the thing.' });
            const pinned = card('0001', 'testing');

            expect(() => assertDispatchable(head, pinned, [head])).not.toThrow();
        });
    });
});
