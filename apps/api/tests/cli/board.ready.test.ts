import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, reasonResponse, urlOf } from './sdk-fetch.helper.js';

// `board.ready.ts` reads nothing for itself any more. Card 0078 took away its own `pg` connection
// (whether the board has cards became an API question); now stage config is a `wilson.stage_configs`
// row behind `GET /api/stages` rather than `config/stages.yaml` under `PROJECT_BOARD_ROOT`, so both
// halves of the check are API calls, stubbed at `fetch` the same way every other ported command is —
// see the module doc on `boardReady`.
const { boardReady } = await import('../../../../packages/cli/src/checks/board.ready.js');

type CheckResult = { ok: boolean; message: string; fixHint?: string };
type RunFn = (ctx: unknown) => Promise<CheckResult>;
const run = boardReady.run as unknown as RunFn;

const columns = (stages: string[]) => jsonResponse({ stages, nonStages: ['parking-lot', 'merged', 'poisoned', 'dropped'] });

describe('boardReady', () => {
    it('reports a refused connection with the same "is it running?" message every other command gives', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);

        const result = await run(buildCtx().ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('is it running?');
    });

    it('reports the API-supplied reason when the stage config does not load, and points at `wilson board init`', async () => {
        fetchMock.mockResolvedValueOnce(
            reasonResponse(500, 'project "wilson" has no stage config; run `wilson board init` or `wilson stages set <file>`'),
        );

        const result = await run(buildCtx().ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe('project "wilson" has no stage config; run `wilson board init` or `wilson stages set <file>`');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/stages');
        expect(result.fixHint).toContain('wilson board init');
        // Card 0079: `wilson run` is gone, so the fix hint for "the API is unreachable" must point at
        // how the API actually starts now, not a command that no longer exists.
        expect(result.fixHint).toContain('pnpm --filter @wilson/api start');
        expect(result.fixHint).not.toContain('wilson run');
    });

    it('fails when the stage config defines no stages, without asking for the cards at all', async () => {
        fetchMock.mockResolvedValueOnce(columns([]));

        const result = await run(buildCtx().ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe('stage config defines no stages');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails with a fix hint when the stages are configured but the board has no cards yet', async () => {
        fetchMock.mockResolvedValueOnce(columns(['implementing', 'testing']));
        fetchMock.mockResolvedValueOnce(jsonResponse([]));

        const result = await run(buildCtx().ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe('no cards on the board');
        expect(result.fixHint).toContain('wilson card create');
    });

    it('asks the API for the stages and then the cards, and reports both', async () => {
        fetchMock.mockResolvedValueOnce(columns(['implementing', 'testing']));
        fetchMock.mockResolvedValueOnce(jsonResponse([{ id: '0001' }, { id: '0002' }]));

        const result = await run(buildCtx().ctx);

        expect(result.ok).toBe(true);
        expect(result.message).toBe('2 cards · stages: implementing, testing');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/stages');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards');
    });
});
