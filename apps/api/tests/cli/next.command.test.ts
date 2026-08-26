import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `next.command.ts` off `container.get(...)` and onto `@wilson/sdk`. It used to read
// `BoardRepository.list()` and call the local `nextCard` with a hard-coded `NON_STAGE_STATES`; now it
// fetches cards and columns over HTTP (`GET /api/cards` and `GET /api/stages`, in parallel) and feeds
// `columns.nonStages` into the locally-reimplemented `nextCard` (`board-view.ts`).
const { default: command } = await import('../../../../packages/cli/src/commands/card/next.command.js');

const run = (ctx: unknown) => (command.run as unknown as Handler)({}, ctx, []);

const card = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: '0001',
    title: 'x',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: false,
    ...overrides,
});

// A fresh `Response` per call — its body can only be read once, and each test's `fetchMock` queue
// needs its own.
const columns = () =>
    jsonResponse({ stages: ['planning', 'implementing', 'testing'], nonStages: ['parking-lot', 'merged', 'poisoned', 'dropped'] });

describe('wilson card next', () => {
    it('fetches cards and stage columns in parallel, and reports the lowest-id workable card', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0002', stage: 'testing' }), card({ id: '0001', stage: 'implementing' })]));
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        // `Promise.all([api.board.listCards(), api.board.listBoardColumns()])` calls both array
        // elements synchronously in that order, so the mock queue reflects it: cards first, columns
        // second.
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/stages');
        expect(logger.info).toHaveBeenCalledWith('0001  implementing  x');
    });

    it('reports there is nothing to do when the board has no workable cards', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ stage: 'parking-lot' })]));
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx);

        expect(logger.info).toHaveBeenCalledWith('nothing to do — the board has no workable cards');
    });

    it('reports that every remaining card is waiting on a dependency, and lists what blocks each one', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0002', stage: 'implementing', dependsOn: ['0003'] })]));
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx);

        expect(logger.info).toHaveBeenCalledWith('nothing to do — every remaining card is waiting on a dependency');
        expect(logger.info).toHaveBeenCalledWith('\nblocked:');
        expect(logger.info).toHaveBeenCalledWith('  0002  x  (waiting on 0003)');
    });

    it('annotates a blocked-on dependency that dropped or poisoned, distinct from one still unfinished', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                card({ id: '0079', stage: 'implementing', dependsOn: ['0078', '0085'] }),
                card({ id: '0078', stage: 'implementing' }),
                card({ id: '0085', stage: 'dropped' }),
            ]),
        );
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx);

        expect(logger.info).toHaveBeenCalledWith('  0079  x  (waiting on 0078, 0085 (dropped — will never merge))');
    });

    it('prints flagged cards first, above the next workable one, with their reason', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                card({ id: '0001', stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }),
                card({ id: '0002', stage: 'implementing' }),
            ]),
        );
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx);

        const messages = logger.info.mock.calls.map((c: unknown[]) => c[0]);
        expect(messages).toContain('flagged:');
        expect(messages).toContain('  0001  x  (stuck)');
        const flaggedIndex = messages.indexOf('flagged:');
        const nextIndex = messages.indexOf('0002  implementing  x');
        expect(flaggedIndex).toBeGreaterThanOrEqual(0);
        expect(nextIndex).toBeGreaterThan(flaggedIndex);
    });

    it('falls back to "needsHuman is set" for a flagged card with no reason recorded', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ needsHuman: true })]));
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx);

        expect(logger.info).toHaveBeenCalledWith('  0001  x  (needsHuman is set)');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
