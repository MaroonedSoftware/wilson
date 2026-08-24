import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardConfig, BoardRepository, CardJobs, JobBroker, PgBoss, loadStages, whyNotDispatchable } from '@wilson/api/cli-bootstrap';

/**
 * Enqueue a card's current stage on the job queue.
 *
 * Enqueues and returns — it does not run the stage itself, and this process does not have to stay
 * alive for that to happen. Whatever process holds the `JobRunner` (a server that ran the Jobs
 * module's `start`) picks the job up and runs it; that process is the one that has to stay running.
 */
const command: CommandModule = {
    description: "Enqueue a card's current stage on the job queue",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: requireContainer(async (_opts, ctx, args) => {
        const cardId = String(args[0]);
        const boardConfig = ctx.container.get(BoardConfig);
        const board = ctx.container.get(BoardRepository);
        const broker = ctx.container.get(JobBroker);

        const card = await board.read(cardId);
        const stageName = card.frontmatter.stage;

        // Refuse before enqueuing rather than let pg-boss dispatch a job nothing can run — a card
        // sitting in `needs-human` or `manual` produced exactly that job, thrown on and retried by
        // pg-boss until it dead-lettered, with no possible outcome.
        const stages = await loadStages(boardConfig.boardRoot);
        const notDispatchable = whyNotDispatchable(stageName, stages);
        if (notDispatchable) {
            ctx.logger.error(`cannot enqueue ${cardId}: ${notDispatchable.reason}`);
            ctx.logger.error(`move it to a dispatchable stage first: wilson card move ${cardId} <stage>`);
            return 1;
        }

        // pg-boss refuses to send on an unopened connection, and nothing has opened one: johnny5's
        // CLI bootstrap runs every module's `setup` but never its `start`, so JobsModule.start()
        // — which is where the daemon's runner opens pg-boss — has not fired in this process.
        // A producer-only command has to open and close it itself.
        const pgBoss = ctx.container.get(PgBoss);
        await pgBoss.start();
        try {
            // Refuse a card something is already carrying. Two jobs for one card means two agents in
            // one worktree on one branch, which is the failure this check exists to make impossible —
            // and the same check a poller will make on every tick.
            const cardJobs = ctx.container.get(CardJobs);
            const running = await cardJobs.inFlight(cardId);
            if (running) {
                ctx.logger.error(`cannot enqueue ${cardId}: job ${running} is already carrying it`);
                return 1;
            }

            const jobId = await broker.send('card.stage', { cardId, stageName });
            await cardJobs.record(cardId, jobId);
            ctx.logger.info(`enqueued ${cardId} · ${stageName} (job ${jobId})`);
        } finally {
            await pgBoss.stop();
        }
        ctx.logger.info('the job runs in whatever process holds the JobRunner — that process must stay running for it to happen.');
        return 0;
    }),
};

export default command;
