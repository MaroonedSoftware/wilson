import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `list.command.ts` off `container.get(...)` and onto `@wilson/sdk`. It used to read
// `BoardRepository.list()` in-process; now it calls `GET /api/cards` and formats the same summary
// line from the wire shape (`CardSummary`, flat — no `frontmatter` wrapper).
const { default: command } = await import('../../../../packages/cli/src/commands/card/list.command.js');

const run = (ctx: unknown) => (command.run as unknown as Handler)({}, ctx, []);

const card = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: '0001',
    title: 'x',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: false,
    ...overrides,
});

describe('wilson card list', () => {
    it('reports that there are no cards yet, without formatting a table, when the board is empty', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(logger.info).toHaveBeenCalledWith('no cards yet — `wilson board init` scaffolds the board, then write one by hand');
    });

    it('lists every card, padding the stage column to the widest stage name', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([card({ id: '0001', stage: 'backlog', title: 'a' }), card({ id: '0002', stage: 'implementing', title: 'b' })]),
        );
        const { ctx, logger } = buildCtx();

        await run(ctx);

        expect(logger.info).toHaveBeenCalledWith('0001  backlog       a');
        expect(logger.info).toHaveBeenCalledWith('0002  implementing  b');
    });

    it('marks a card blocked on an unfinished dependency, and flags one waiting on a human', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                card({ id: '0001', stage: 'merged' }),
                card({ id: '0002', stage: 'implementing', dependsOn: ['0001', '0003'] }),
                card({ id: '0003', stage: 'testing', needsHuman: true }),
            ]),
        );
        const { ctx, logger } = buildCtx();

        await run(ctx);

        // 0001 is merged, so it is satisfied and does not appear in the blocked list.
        expect(logger.info).toHaveBeenCalledWith('0002  implementing  x (blocked on 0003)');
        expect(logger.info).toHaveBeenCalledWith('0003  testing       x [needs human]');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
