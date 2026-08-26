import { describe, expect, it } from 'vitest';
import { buildCtx, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `approve.command.ts` off `container.get(...)` and onto `@wilson/sdk`. The stage
// guard, the empty-scope refusal, and pinning the approved version are `BoardWriteService.approve`'s
// job now and are tested there (apps/api/tests/modules/board/board.write.service.test.ts) — this
// command just calls it and reports where the card landed.
//
// Card 0127 reconciled `approve` with the new gate: entering `backlog` is the approval now, so
// `approve` moved from pinning on the way *out* of `backlog` to pinning on the way *in*, from
// `planning`. The endpoint, the CLI verb and its reported message all changed to match.
const { default: command } = await import('../../../../packages/cli/src/commands/card/approve.command.js');

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

describe('wilson card approve', () => {
    it('calls approve and reports planning moving to the stage the API says it landed on', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0003', title: 'x', stage: 'backlog', dependsOn: [], needsHuman: false }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0003');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0003/approve');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(logger.info).toHaveBeenCalledWith('0003: planning → backlog (plan pinned)');
    });

    it('prints the API-supplied reason and exits 1 for a card outside planning, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '0001 is not in planning'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0001 is not in planning');
    });

    it('prints the API-supplied reason for a planning card whose plan has an empty "Files in scope"', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '0002 has an empty "Files in scope"'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0002');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0002 has an empty "Files in scope"');
    });
});
