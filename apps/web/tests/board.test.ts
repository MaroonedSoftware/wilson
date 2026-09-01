import { describe, expect, it } from 'vitest';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import {
    ageInStage,
    cardState,
    collapsedColumnsKey,
    columnOrder,
    groupByStage,
    stagesById,
    toggleCollapsed,
    unfinishedDeps,
} from '#src/lib/board.js';

const card = (id: string, stage: string, dependsOn: string[] = [], needsHuman = false): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn,
    needsHuman,
});

/** A parking-lot card with an explicit `position` — card 0091's field, card 0047 is the first to read. */
const parked = (id: string, position?: number, needsHuman = false): CardSummary => ({
    id,
    title: `card ${id}`,
    stage: 'parking-lot',
    dependsOn: [],
    needsHuman,
    position,
});

const columns: BoardColumns = {
    stages: ['planning', 'backlog', 'implementing', 'testing', 'review', 'ready'],
    nonStages: ['parking-lot', 'merged', 'needs-human', 'poisoned', 'dropped'],
};

describe('columnOrder', () => {
    it('puts the parking lot first, then the stages, then the terminal states', () => {
        expect(columnOrder(columns, [])).toEqual([
            'parking-lot',
            'planning',
            'backlog',
            'implementing',
            'testing',
            'review',
            'ready',
            'merged',
            'needs-human',
            'poisoned',
            'dropped',
        ]);
    });

    it('appends a stage the config does not name rather than hiding its cards', () => {
        expect(columnOrder(columns, [card('0001', 'some-made-up-stage')])).toContain('some-made-up-stage');
    });
});

describe('groupByStage', () => {
    it('groups cards into their stage, lowest id first', () => {
        const grouped = groupByStage([card('0002', 'review'), card('0001', 'review'), card('0003', 'ready')]);
        expect(grouped.get('review')?.map(c => c.id)).toEqual(['0001', '0002']);
        expect(grouped.get('ready')?.map(c => c.id)).toEqual(['0003']);
    });

    it('sorts a flagged card to the top of its column, ahead of lower ids', () => {
        const grouped = groupByStage([
            card('0001', 'review'),
            card('0002', 'review'),
            card('0003', 'review', [], true),
        ]);
        expect(grouped.get('review')?.map(c => c.id)).toEqual(['0003', '0001', '0002']);
    });

    it('does not let a flagged card jump to a different column — it only sorts within its own', () => {
        const grouped = groupByStage([card('0001', 'review'), card('0002', 'ready', [], true)]);
        expect(grouped.get('review')?.map(c => c.id)).toEqual(['0001']);
        expect(grouped.get('ready')?.map(c => c.id)).toEqual(['0002']);
    });

    it('falls back to id order within a column with no flagged cards, exactly as before', () => {
        const grouped = groupByStage([card('0003', 'review'), card('0001', 'review'), card('0002', 'review')]);
        expect(grouped.get('review')?.map(c => c.id)).toEqual(['0001', '0002', '0003']);
    });

    describe('the parking lot', () => {
        it('sorts by position instead of id, lowest first', () => {
            const grouped = groupByStage([parked('0001', 2), parked('0002', 0), parked('0003', 1)]);
            expect(grouped.get('parking-lot')?.map(c => c.id)).toEqual(['0002', '0003', '0001']);
        });

        it('sorts a card with no position after every card that has one', () => {
            const grouped = groupByStage([parked('0001', undefined), parked('0002', 0), parked('0003', 1)]);
            expect(grouped.get('parking-lot')?.map(c => c.id)).toEqual(['0002', '0003', '0001']);
        });

        it('falls back to id among cards that all lack a position — predating card 0091, none jump the queue', () => {
            const grouped = groupByStage([parked('0003'), parked('0001'), parked('0002')]);
            expect(grouped.get('parking-lot')?.map(c => c.id)).toEqual(['0001', '0002', '0003']);
        });

        it('does not sort a flagged card to the top — position rules the parking lot even over the flag', () => {
            const grouped = groupByStage([parked('0001', 0), parked('0002', 1), parked('0003', 2, true)]);
            // Flagged '0003' stays last, at its own position, unlike every other column above.
            expect(grouped.get('parking-lot')?.map(c => c.id)).toEqual(['0001', '0002', '0003']);
        });

        it('leaves every other column sorted flagged-first, unaffected by any position field', () => {
            const grouped = groupByStage([
                parked('0009', 0),
                card('0001', 'review', [], false),
                card('0002', 'review', [], true),
            ]);
            expect(grouped.get('review')?.map(c => c.id)).toEqual(['0002', '0001']);
        });
    });
});

describe('unfinishedDeps', () => {
    const board = [card('0034', 'merged'), card('0021', 'implementing'), card('0035', 'implementing', ['0034'])];

    it('does not report a dependency that merged', () => {
        expect(unfinishedDeps(card('0035', 'implementing', ['0034']), stagesById(board))).toEqual([]);
    });

    it('reports a dependency that has not merged', () => {
        expect(unfinishedDeps(card('0022', 'implementing', ['0021']), stagesById(board))).toEqual(['0021']);
    });

    it('treats a dependency missing from the board as unfinished', () => {
        expect(unfinishedDeps(card('0099', 'implementing', ['9999']), stagesById(board))).toEqual(['9999']);
    });
});

describe('cardState', () => {
    it('maps a flagged card to needs-human, regardless of stage', () => {
        expect(cardState(card('0001', 'implementing', [], true))).toBe('needs-human');
    });

    it('overrides a would-be state face with needs-human when the card is also flagged', () => {
        expect(cardState(card('0001', 'merged', [], true))).toBe('needs-human');
    });

    it('maps the parking lot to parked', () => {
        expect(cardState(card('0001', 'parking-lot'))).toBe('parked');
    });

    it('maps poisoned to poisoned', () => {
        expect(cardState(card('0001', 'poisoned'))).toBe('poisoned');
    });

    it('maps merged to passed', () => {
        expect(cardState(card('0001', 'merged'))).toBe('passed');
    });

    it('claims no state face for a plain in-flight stage', () => {
        expect(cardState(card('0001', 'implementing'))).toBeUndefined();
    });
});

describe('collapsedColumnsKey', () => {
    it('produces a different key for two different projects', () => {
        expect(collapsedColumnsKey('demo')).not.toBe(collapsedColumnsKey('other'));
    });

    it('names the localStorage key by project', () => {
        expect(collapsedColumnsKey('demo')).toBe('wilson:collapsed-columns:demo');
    });
});

describe('toggleCollapsed', () => {
    it('adds a stage that is not yet in the set', () => {
        expect(toggleCollapsed(['implementing'], 'merged')).toEqual(['implementing', 'merged']);
    });

    it('removes a stage that is already in the set', () => {
        expect(toggleCollapsed(['implementing', 'merged'], 'merged')).toEqual(['implementing']);
    });

    it('does not mutate the input array', () => {
        const collapsed = ['merged'];
        toggleCollapsed(collapsed, 'implementing');
        expect(collapsed).toEqual(['merged']);
    });
});

describe('ageInStage', () => {
    const now = new Date('2026-01-10T12:00:00.000Z');

    it('renders minutes for under an hour', () => {
        expect(ageInStage('2026-01-10T11:45:00.000Z', now)).toBe('15m in stage');
    });

    it('renders hours for under a day', () => {
        expect(ageInStage('2026-01-10T06:00:00.000Z', now)).toBe('6h in stage');
    });

    it('renders days at a day or more', () => {
        expect(ageInStage('2026-01-07T12:00:00.000Z', now)).toBe('3d in stage');
    });
});
