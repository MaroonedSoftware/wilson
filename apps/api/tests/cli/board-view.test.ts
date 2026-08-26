import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { CardEvent, CardSummary } from '@wilson/sdk';
import {
    deadDependencies,
    deadStages,
    describeDependency,
    filesInScope,
    nextCard,
    timeInCurrentStage,
    unsatisfiedDependencies,
} from '../../../../packages/cli/src/board-view.js';

// Card 0078 gives the CLI its own copy of a handful of pure functions it used to import from
// `@wilson/api/cli-bootstrap` (`unsatisfiedDependencies`/`nextCard` from
// `apps/api/src/modules/board/next.card.ts`, `filesInScope` from `apps/api/src/modules/board/card.ts`,
// `timeInCurrentStage` from `apps/api/src/modules/events/time.in.stage.ts`), adapted to the SDK's flat
// `CardSummary`/`CardEvent` shapes. `next.command.test.ts` and `show.command.test.ts` exercise these
// indirectly through the commands that call them; this file drives each function directly, with the
// edge cases those command tests do not need to reach — this is the one place left where a drift from
// the board-side originals would go unnoticed otherwise (see the module doc on `board-view.ts`).

const card = (overrides: Partial<CardSummary> = {}): CardSummary => ({
    id: '0001',
    title: 'x',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: false,
    ...overrides,
});

describe('unsatisfiedDependencies', () => {
    it('returns nothing for a card with no dependencies', () => {
        expect(unsatisfiedDependencies(card({ dependsOn: [] }), [])).toEqual([]);
    });

    it('treats a dependency that has reached merged as satisfied', () => {
        const dep = card({ id: '0002', stage: 'merged' });
        expect(unsatisfiedDependencies(card({ dependsOn: ['0002'] }), [dep])).toEqual([]);
    });

    it('treats a dependency still short of merged as unsatisfied', () => {
        const dep = card({ id: '0002', stage: 'implementing' });
        expect(unsatisfiedDependencies(card({ dependsOn: ['0002'] }), [dep])).toEqual(['0002']);
    });

    it('treats a dependency missing from the board entirely as unsatisfied, never as fine', () => {
        expect(unsatisfiedDependencies(card({ dependsOn: ['0099'] }), [])).toEqual(['0099']);
    });

    it('preserves the order dependencies are listed in, filtering out only the finished ones', () => {
        const cards = [card({ id: '0002', stage: 'merged' }), card({ id: '0003', stage: 'implementing' })];
        expect(unsatisfiedDependencies(card({ dependsOn: ['0003', '0002', '0099'] }), cards)).toEqual(['0003', '0099']);
    });
});

describe('deadStages', () => {
    it('keeps a terminal-but-not-merged state, given the board’s real non-stage list', () => {
        expect(deadStages(['parking-lot', 'merged', 'poisoned', 'dropped'])).toEqual(['poisoned', 'dropped']);
    });

    it('excludes merged — a dependency there is satisfied, not dead', () => {
        expect(deadStages(['merged'])).toEqual([]);
    });

    it('excludes parking-lot — a card there can still move on, so it is not terminal', () => {
        expect(deadStages(['parking-lot'])).toEqual([]);
    });

    it('does not hard-code the set — a differently-named terminal state passes through untouched', () => {
        expect(deadStages(['parking-lot', 'merged', 'abandoned'])).toEqual(['abandoned']);
    });
});

describe('deadDependencies', () => {
    const nonStages = ['parking-lot', 'merged', 'poisoned', 'dropped'];

    it('reports a dependency sitting in dropped', () => {
        const dep = card({ id: '0085', stage: 'dropped' });
        expect(deadDependencies(card({ dependsOn: ['0085'] }), [dep], nonStages)).toEqual(['0085']);
    });

    it('reports a dependency sitting in poisoned', () => {
        const dep = card({ id: '0085', stage: 'poisoned' });
        expect(deadDependencies(card({ dependsOn: ['0085'] }), [dep], nonStages)).toEqual(['0085']);
    });

    it('does not report a dependency still in progress — unsatisfied is not dead', () => {
        const dep = card({ id: '0085', stage: 'implementing' });
        expect(deadDependencies(card({ dependsOn: ['0085'] }), [dep], nonStages)).toEqual([]);
    });

    it('does not report a merged dependency', () => {
        const dep = card({ id: '0085', stage: 'merged' });
        expect(deadDependencies(card({ dependsOn: ['0085'] }), [dep], nonStages)).toEqual([]);
    });

    it('does not report a dependency missing from the board entirely', () => {
        expect(deadDependencies(card({ dependsOn: ['0099'] }), [], nonStages)).toEqual([]);
    });

    it('picks only the dead ones out of a mix, preserving dependsOn order', () => {
        const cards = [
            card({ id: '0002', stage: 'merged' }),
            card({ id: '0003', stage: 'dropped' }),
            card({ id: '0004', stage: 'implementing' }),
        ];
        expect(deadDependencies(card({ dependsOn: ['0004', '0003', '0002'] }), cards, nonStages)).toEqual(['0003']);
    });
});

describe('describeDependency', () => {
    it('names the stage on a dead dependency', () => {
        const dep = card({ id: '0085', stage: 'dropped' });
        expect(describeDependency('0085', [dep], ['0085'])).toBe('0085 (dropped — will never merge)');
    });

    it('returns the bare id for a dependency that is not dead', () => {
        const dep = card({ id: '0085', stage: 'implementing' });
        expect(describeDependency('0085', [dep], [])).toBe('0085');
    });
});

describe('nextCard', () => {
    const nonStages = ['parking-lot', 'merged'];

    it('excludes a card sitting in a non-stage state entirely — not a candidate, not blocked, not flagged', () => {
        const result = nextCard([card({ stage: 'parking-lot' })], nonStages);

        expect(result.next).toBeUndefined();
        expect(result.blocked).toEqual([]);
        expect(result.flagged).toEqual([]);
    });

    it('picks the lowest-id workable card as next, sorting candidates by id', () => {
        const result = nextCard([card({ id: '0003' }), card({ id: '0001' }), card({ id: '0002' })], nonStages);

        expect(result.next?.id).toBe('0001');
    });

    it('sorts blocked cards by id and reports each one’s unfinished dependencies', () => {
        const result = nextCard(
            [
                card({ id: '0002', dependsOn: ['0010'] }),
                card({ id: '0001', dependsOn: ['0011'] }),
            ],
            nonStages,
        );

        expect(result.blocked.map(b => b.card.id)).toEqual(['0001', '0002']);
        expect(result.blocked[0]!.blockedBy).toEqual(['0011']);
        expect(result.blocked[1]!.blockedBy).toEqual(['0010']);
    });

    it('sorts flagged cards by id', () => {
        const result = nextCard([card({ id: '0002', needsHuman: true }), card({ id: '0001', needsHuman: true })], nonStages);

        expect(result.flagged.map(c => c.id)).toEqual(['0001', '0002']);
    });

    it('reports a card that is both needsHuman and would otherwise be blocked as flagged only, never also as blocked', () => {
        const result = nextCard([card({ id: '0001', needsHuman: true, dependsOn: ['0099'] })], nonStages);

        expect(result.flagged.map(c => c.id)).toEqual(['0001']);
        expect(result.blocked).toEqual([]);
    });

    it('never picks a flagged or blocked card as next', () => {
        const result = nextCard(
            [card({ id: '0001', needsHuman: true }), card({ id: '0002', dependsOn: ['0099'] })],
            nonStages,
        );

        expect(result.next).toBeUndefined();
    });
});

describe('filesInScope', () => {
    it('returns nothing when the section is absent', () => {
        expect(filesInScope({})).toEqual([]);
    });

    it('parses -, * and + bullet markers alike', () => {
        const sections = { 'Files in scope': '- src/a.ts\n* src/b.ts\n+ src/c.ts' };
        expect(filesInScope(sections)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });

    it('strips inline code backticks around a glob', () => {
        const sections = { 'Files in scope': '- `packages/cli/src/**`' };
        expect(filesInScope(sections)).toEqual(['packages/cli/src/**']);
    });

    it('drops blank lines and an HTML-comment placeholder line', () => {
        const sections = { 'Files in scope': '- src/a.ts\n\n<!-- nothing else -->\n' };
        expect(filesInScope(sections)).toEqual(['src/a.ts']);
    });

    it('trims surrounding whitespace on each line', () => {
        const sections = { 'Files in scope': '   -   src/a.ts   ' };
        expect(filesInScope(sections)).toEqual(['src/a.ts']);
    });
});

describe('timeInCurrentStage', () => {
    const now = DateTime.fromISO('2026-01-01T12:00:00.000Z');

    const event = (overrides: Partial<CardEvent>): CardEvent => ({
        id: 'e1',
        type: 'card.created',
        stage: null,
        payload: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    });

    it('returns undefined for a card with no recorded events', () => {
        expect(timeInCurrentStage([], now)).toBeUndefined();
    });

    it('measures from the earliest event when there has never been a transition', () => {
        const duration = timeInCurrentStage([event({ createdAt: '2026-01-01T10:00:00.000Z' })], now);

        expect(duration?.as('hours')).toBe(2);
    });

    it('measures from the most recent transition.written event, ignoring an earlier one and later non-transition events', () => {
        const events = [
            event({ id: 'e1', type: 'transition.written', createdAt: '2026-01-01T00:00:00.000Z' }),
            event({ id: 'e2', type: 'transition.written', createdAt: '2026-01-01T09:00:00.000Z' }),
            event({ id: 'e3', type: 'note.added', createdAt: '2026-01-01T10:00:00.000Z' }),
        ];

        const duration = timeInCurrentStage(events, now);

        expect(duration?.as('hours')).toBe(3);
    });
});
