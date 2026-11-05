import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { AppApiService } from '#modules/apps/app.api.service.js';
import type { BoardService } from '#modules/board/board.service.js';
import type { StagesService } from '#modules/stages/stages.service.js';

const AT = DateTime.fromISO('2026-11-05T12:00:00.000Z', { zone: 'utc' });

const CARD = {
    id: '0001',
    title: 'A card',
    stage: 'ready',
    doneReason: undefined,
    planCheck: 'checking',
    planCheckReason: 'still going',
    branch: 'recorded',
    resolvedBranch: 'resolved',
    dependsOn: ['0000'],
    needsHuman: true,
    needsHumanReason: 'a question',
    blocked: {
        category: 'decision',
        tried: 'reading',
        question: 'which?',
        options: ['a'],
        stage: 'planning',
        askedAt: AT,
        patchPath: '/runs/0001.patch',
    },
    position: 3,
    splitFrom: '0000',
    stageEnteredAt: AT,
    mergeStatus: { state: 'clean', target: 'main', conflicts: [], movedUnder: [], reason: undefined },
    somethingTheBoardGainsLater: 'secret',
};

const COUNTS = { attempts: 1, passed: 1, failed: 0, interrupted: 0, inputTokens: 5, cachedInputTokens: 2, outputTokens: 3 };

const service = (board: Record<string, unknown>, stages: Record<string, unknown> = {}) =>
    new AppApiService(board as unknown as BoardService, stages as unknown as StagesService);

/** The contract's v1 is a promise: these are exact matches, so a new or lost field fails them. */
describe('AppApiService', () => {
    it('sends a card with the listed fields and no others', async () => {
        const [card] = await service({ list: vi.fn().mockResolvedValue([CARD]) }).listCards();

        expect(card).toStrictEqual({
            id: '0001',
            title: 'A card',
            stage: 'ready',
            planCheck: 'checking',
            planCheckReason: 'still going',
            branch: 'resolved',
            dependsOn: ['0000'],
            needsHuman: true,
            needsHumanReason: 'a question',
            blocked: { category: 'decision', tried: 'reading', question: 'which?', options: ['a'], stage: 'planning', askedAt: AT },
            position: 3,
            splitFrom: '0000',
            stageEnteredAt: AT,
            mergeStatus: { state: 'clean', target: 'main', conflicts: [], movedUnder: [] },
        });
    });

    it('falls back to the recorded branch', async () => {
        const [card] = await service({ list: vi.fn().mockResolvedValue([{ ...CARD, resolvedBranch: undefined }]) }).listCards();

        expect(card?.branch).toBe('recorded');
    });

    it('adds the body, sections and pieces to one card', async () => {
        const getById = vi.fn().mockResolvedValue({
            ...CARD,
            body: 'text',
            sections: { plan: 'more' },
            pieces: [{ id: '0002', title: 'Piece', stage: 'done', doneReason: 'merged', extra: true }],
        });

        const card = await service({ getById }).getCard('0001');

        expect(getById).toHaveBeenCalledWith('0001');
        expect(card).toMatchObject({ body: 'text', sections: { plan: 'more' } });
        expect(card.pieces).toStrictEqual([{ id: '0002', title: 'Piece', stage: 'done', doneReason: 'merged' }]);
        expect(card).not.toHaveProperty('somethingTheBoardGainsLater');
    });

    it('sends only the columns', async () => {
        const columns = vi.fn().mockResolvedValue({ stages: ['a'], nonStages: ['b'], extra: true });

        expect(await service({}, { columns }).listBoardColumns()).toStrictEqual({ stages: ['a'], nonStages: ['b'] });
    });

    it('leaves the payload out of an activity event', async () => {
        const activity = vi
            .fn()
            .mockResolvedValue([
                { id: '9', cardId: '0001', cardTitle: null, type: 'stage.passed', stage: null, payload: { path: '/secret' }, createdAt: AT },
            ]);

        const events = await service({ activity }).listProjectActivity({ limit: 5, before: 10 });

        expect(activity).toHaveBeenCalledWith({ limit: 5, before: 10 });
        expect(events).toStrictEqual([{ id: '9', cardId: '0001', cardTitle: null, type: 'stage.passed', stage: null, createdAt: AT }]);
    });

    it('sends the stats with the listed fields and no others', async () => {
        const stats = vi.fn().mockResolvedValue({
            since: AT,
            until: AT,
            zone: 'UTC',
            total: { ...COUNTS, cards: 1, extra: true },
            stages: [{ ...COUNTS, stage: 'review', cards: 1, extra: true }],
            days: [{ ...COUNTS, date: '2026-11-05', extra: true }],
            topCards: [{ ...COUNTS, cardId: '0001', extra: true }],
            conversations: [{ kind: 'planning', turns: 1, cards: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, extra: true }],
            extra: true,
        });

        const answer = await service({ stats }).getProjectStats({ days: 7 });

        expect(stats).toHaveBeenCalledWith({ days: 7 });
        expect(answer).toStrictEqual({
            since: AT,
            until: AT,
            zone: 'UTC',
            total: { ...COUNTS, cards: 1 },
            stages: [{ ...COUNTS, stage: 'review', cards: 1 }],
            days: [{ ...COUNTS, date: '2026-11-05' }],
            topCards: [{ ...COUNTS, cardId: '0001' }],
            conversations: [{ kind: 'planning', turns: 1, cards: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }],
        });
    });
});
