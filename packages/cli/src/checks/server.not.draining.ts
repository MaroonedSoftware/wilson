import type { Check } from '@maroonedsoftware/johnny5';
import { apiClient } from '../api-client.js';

/**
 * A drain outlives the restart it was for, so a forgotten one leaves a board that looks healthy and
 * starts nothing. An API that cannot answer passes, for the reason `daemonCurrent` gives.
 */
export const serverNotDraining: Check = {
    name: 'server not draining',
    run: async ctx => {
        const status = await apiClient(ctx)
            .settings.getDrainStatus()
            .catch(() => undefined);
        if (!status) return { ok: true, message: 'drain state unavailable; skipped' };
        if (!status.draining) return { ok: true, message: 'not draining' };

        return {
            ok: false,
            message: `draining, with ${status.held} stage(s) held`,
            fixHint: 'No stage starts until this ends. Run `wilson server resume` if the update is finished.',
        };
    },
};
