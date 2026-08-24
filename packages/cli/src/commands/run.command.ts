import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig, JobRunner } from '@wilson/api/cli-bootstrap';

/**
 * The daemon: start the `JobRunner` and block until told to stop.
 *
 * johnny5's CLI bootstrap never calls module `start` hooks — only `setup` runs before the
 * container is built — so `JobRunner.start()` has never fired until this command calls it
 * explicitly. This command drains whatever is already queued; nothing here enqueues cards on
 * its own. Use `wilson card start <id>` to feed it.
 */
const command: CommandModule = {
    description:
        "Run the job daemon: drains jobs already on the queue and blocks until stopped. Doesn't enqueue " +
        'anything itself — use `wilson card start <id>` to feed it.',
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
        await runner.stop();
        ctx.logger.info('stopped');
        return 0;
    }),
};

export default command;
