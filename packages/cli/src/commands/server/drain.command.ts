import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { describeDrain } from '../../drain-view.js';

/** How often `--wait` asks again. */
export const DRAIN_WAIT_POLL_MS = 5_000;

interface DrainOpts {
    wait?: boolean;
}

/**
 * Let running stages finish and start nothing new, so the server can be restarted without losing
 * one. Everything waiting stays queued through the restart, and the drain stays on afterwards until
 * `wilson server resume`.
 *
 * `--wait` is for a deploy script: it exits 0 once a restart is safe, which can take as long as the
 * longest running stage.
 */
const command: CommandModule<DrainOpts> = {
    description: 'Stop starting stages so the server can restart safely',
    options: [{ flags: '--wait', description: 'Wait until a restart is safe' }],
    run: withApi<DrainOpts>(async (opts, ctx, _args, api) => {
        let status = await api.settings.setDrain({ draining: true });
        ctx.logger.info(describeDrain(status));

        if (!opts.wait) return 0;

        let last = describeDrain(status);
        while (!status.safeToRestart) {
            await new Promise(resolve => setTimeout(resolve, DRAIN_WAIT_POLL_MS));
            status = await api.settings.getDrainStatus();
            const next = describeDrain(status);
            if (next !== last) ctx.logger.info(next);
            last = next;
        }
        return 0;
    }),
};

export default command;
