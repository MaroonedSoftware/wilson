import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from '@maroonedsoftware/johnny5';
import { apiClient, describeApiError } from '../api-client.js';

/**
 * The board must be queryable and its stage config must exist.
 *
 * Two halves, and they now live on two different sides of the API: whether `PROJECT_BOARD_ROOT` is
 * set and whether `stages.yaml` exists under it are filesystem facts this process can still read for
 * itself, cheaply, without the API up. Whether the board actually has cards is a question about the
 * database behind the API now (card 0078 dropped the CLI's own `pg` connection along with its direct
 * container access), so that half is answered by calling the API the same way any other command
 * does — which doubles as this check's proof that the API is reachable at all, with the same "is it
 * running?" message every other command gives on a refused connection.
 *
 * Deep validation of `stages.yaml` itself (does it parse, does every `onPass`/`onFail` target a real
 * stage) is no longer done here either: that logic lives in `apps/api/src/modules/stages/stage.config.ts`,
 * which this package cannot import any more, and duplicating a schema validator is a different order
 * of risk than duplicating the small pure functions in `board-view.ts`. A broken config now surfaces
 * as a generic API error the first time this check (or any command) calls in, rather than the
 * specific parse error it used to report directly — a real loss of detail, accepted here because the
 * config only becomes readable to this process through the API contract.
 */
export const boardReady: Check = {
    name: 'board ready',
    run: async ctx => {
        const root = ctx.config.get('PROJECT_BOARD_ROOT', '');
        if (!root) {
            return { ok: false, message: 'PROJECT_BOARD_ROOT is not set', fixHint: 'Set it in apps/api/.env, then run `wilson board init`.' };
        }
        if (!existsSync(join(root, 'config', 'stages.yaml'))) {
            return { ok: false, message: `no stage config at ${root}/config/stages.yaml`, fixHint: 'Run `wilson board init`.' };
        }

        try {
            const cards = await apiClient(ctx).board.listCards();
            if (cards.length === 0) {
                return {
                    ok: false,
                    message: 'no cards on the board',
                    fixHint: 'Import an existing board with `wilson board import`, or create one with `wilson card create`.',
                };
            }
            return { ok: true, message: `${cards.length} cards · stage config at ${root}/config/stages.yaml` };
        } catch (err) {
            return {
                ok: false,
                message: describeApiError(err, ctx),
                fixHint: 'Start the API — `wilson run` — then run doctor again.',
            };
        }
    },
};
