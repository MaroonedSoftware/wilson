import { describe, expect, it } from 'vitest';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { columnOrder, groupByStage, stagesById, unfinishedDeps } from '#src/lib/board.js';

const card = (id: string, stage: string, dependsOn: string[] = []): CardSummary => ({ id, title: `card ${id}`, stage, dependsOn });

const columns: BoardColumns = {
    stages: ['implementing', 'testing', 'review', 'ready'],
    nonStages: ['parking-lot', 'merged', 'needs-human', 'poisoned', 'dropped'],
};

describe('columnOrder', () => {
    it('puts the parking lot first, then the stages, then the terminal states', () => {
        expect(columnOrder(columns, [])).toEqual([
            'parking-lot',
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
        expect(columnOrder(columns, [card('0001', 'planning')])).toContain('planning');
    });
});

describe('groupByStage', () => {
    it('groups cards into their stage, lowest id first', () => {
        const grouped = groupByStage([card('0002', 'review'), card('0001', 'review'), card('0003', 'ready')]);
        expect(grouped.get('review')?.map(c => c.id)).toEqual(['0001', '0002']);
        expect(grouped.get('ready')?.map(c => c.id)).toEqual(['0003']);
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
