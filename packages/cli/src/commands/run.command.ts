import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { AbandonedCardJobsError, BoardConfig, JobRunner } from '@wilson/api/cli-bootstrap';

/**
 * The daemon: start the `JobRunner` and block until told to stop.
 *
 * johnny5's CLI bootstrap never calls module `start` hooks — only `setup` runs before the
 * container is built — so `JobRunner.start()` has never fired until this command calls it
 * explicitly. This command always drains whatever is already queued; whether it also enqueues
 * cards on its own depends on `POLLER_ENABLED` (`.env.example`), off by default. Either way, the
 * poller's start and stop are folded into `runner.start()`/`runner.stop()` themselves (see
 * `BoundedCardStageJobRunner` in `jobs.module.ts`) — this command does not know or care whether
 * polling is on. `wilson card start <id>` still feeds the queue by hand, poller on or off.
 *
 * `runner.stop()` already does the work of bounding the wait and reporting the truth (see
 * `BoundedCardStageJobRunner` in `jobs.module.ts`) — it stops the poller first, so nothing can enqueue
 * behind the report's back, then resolves on a clean stop and rejects with `AbandonedCardJobsError`
 * when a job was still in flight past the deadline, so this command only has to translate that into
 * what an operator watching the daemon needs: a distinct log line and a non-zero exit rather than the
 * same "stopped" either way.
 */
const command: CommandModule = {
    description:
        'Run the job daemon: drains jobs already on the queue and blocks until stopped. Also enqueues ' +
        'cards on its own when POLLER_ENABLED is set (off by default) — `wilson card start <id>` still ' +
        'works either way.',
    run: requireContainer(async (_opts, ctx) => {
        const runner = ctx.container.get(JobRunner);
        const board = ctx.container.get(BoardConfig);

        await runner.start();
        ctx.logger.info(`daemon up — draining jobs for ${board.project}`);

        let stopping = false;
        await new Promise<void>(resolve => {
            const onSignal = () => {
                if (stopping) {
                    ctx.logger.info('shutdown already in progress — exiting now');
                    process.exit(1);
                }
                stopping = true;
                resolve();
            };
            process.on('SIGINT', onSignal);
            process.on('SIGTERM', onSignal);
        });

        ctx.logger.info('stopping…');
        try {
            await runner.stop();
        } catch (error) {
            if (!(error instanceof AbandonedCardJobsError)) throw error;
            ctx.logger.error(`stopped — ${error.message}`);
            return 1;
        }

        ctx.logger.info('stopped');
        return 0;
    }),
};

export default command;
