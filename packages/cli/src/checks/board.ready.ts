import type { Check } from '@maroonedsoftware/johnny5';
import { apiClient, describeApiError } from '../api-client.js';

/**
 * The board must be queryable and its stage config must load.
 *
 * Both halves are questions about the database behind the API now: stage config is a
 * `wilson.stage_configs` row (it used to be `config/stages.yaml` under `PROJECT_BOARD_ROOT`, which
 * this check could stat for itself), and whether the board has cards was already an API question
 * (card 0078 dropped the CLI's own `pg` connection). So this asks the API twice, the same way any
 * other command does — which doubles as this check's proof that the API is reachable at all, with
 * the same "is it running?" message every other command gives on a refused connection.
 *
 * Deep validation of the config (does it parse, does every `onPass`/`onFail` target a real stage) is
 * the API's: `StageConfigStore.load` refuses a broken document with the specific reason, and
 * `GET /api/stages` carries that reason back here through `describeApiError`, so a config typo
 * reads as the typo rather than as a generic failure.
 */
export const boardReady: Check = {
    name: 'board ready',
    run: async ctx => {
        const api = apiClient(ctx);

        let stages: string[];
        try {
            stages = (await api.board.listBoardColumns()).stages;
        } catch (err) {
            return {
                ok: false,
                message: describeApiError(err, ctx),
                fixHint:
                    'Start the API — `pnpm --filter @wilson/api start` — then run doctor again. A missing stage config is scaffolded by `wilson board init`.',
            };
        }
        if (stages.length === 0) {
            return { ok: false, message: 'stage config defines no stages', fixHint: 'Edit it with `wilson stages edit`.' };
        }

        try {
            const cards = await api.board.listCards();
            if (cards.length === 0) {
                return {
                    ok: false,
                    message: 'no cards on the board',
                    fixHint: 'Create one with `wilson card create`.',
                };
            }
            return { ok: true, message: `${cards.length} cards · stages: ${stages.join(', ')}` };
        } catch (err) {
            return {
                ok: false,
                message: describeApiError(err, ctx),
                fixHint: 'Start the API — `pnpm --filter @wilson/api start` — then run doctor again.',
            };
        }
    },
};
