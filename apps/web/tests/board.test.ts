import { describe, expect, it } from 'vitest';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { columnOrder, groupByStage, stagesById, unfinishedDeps } from '#src/lib/board.js';

const card = (id: string, stage: string, dependsOn: string[] = [], needsHuman = false): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn,
    needsHuman,
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
