import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { CardJobs, JobBroker, PgBoss } from '@wilson/api/cli-bootstrap';

const exec = promisify(execFile);

/**
 * The pid of a running `wilson run` daemon, or undefined if none is.
 *
 * Same probe `daemonCurrent` uses: `wilson run` is `./src/index.ts run`, so its process line
 * contains "index.ts run" and this command's own line ("index.ts card release …") does not.
 */
const runningDaemon = async (): Promise<string | undefined> => {
    const running = await exec('pgrep', ['-f', 'index.ts run']).catch(() => undefined);
    return running?.stdout.trim().split('\n').filter(Boolean)[0];
};

/**
 * Release a card whose job is stuck: cancel the job through the broker and clear the claim.
 *
 * Getting here once meant calling `JobBroker.cancel`, which needs pg-boss connected — and the
 * only door that had been reached for was `JobRunner.start()`. A started `JobRunner` drains the
 * queue: it registers a worker for every job type and starts pulling from it. That improvised
 * command silently became a second daemon, picked up an unrelated pending job, ran a whole stage,
 * and cancelled the healthy job that stage had chained into.
 *
 * The seam this command uses instead is `PgBoss.start()` directly — the same one `card start`
 * already uses to send jobs from a non-daemon process. It opens the connection pg-boss needs for
 * management calls (`send`, `cancel`, `getJob`) without calling `work()` for anything, so nothing
 * is ever registered to consume a queue. Nothing here can pick up, run or chain a stage.
 *
 * That still leaves one thing a producer-only connection cannot tell on its own: whether a job the
 * broker reports as `active` is genuinely being executed right now, or is active only because the
 * worker that claimed it is gone. `getJob` cannot distinguish those — both look identical from
 * outside. The daemon check below is what stands in for that: with no `wilson run` process alive,
 * nothing in this project can possibly be executing a job, so any live claim is necessarily
 * orphaned and safe to cancel. With one alive, an `active` job might really be in flight, so this
 * command refuses outright rather than guess — the same failure mode this whole card exists to
 * prevent, reached a different way.
 *
 * The daemon check only ever disambiguates a card that actually holds a live claim. It runs after
 * `inFlight`, not before: a card with no claim — or one whose job already settled — is "nothing to
 * release" regardless of whether some daemon happens to be running elsewhere. Checking it first
 * would make every card look like a maybe-in-flight job whenever any `wilson run` process is alive,
 * which is exactly the state a wedged handler leaves the daemon in.
 */
const command: CommandModule = {
    description: "Release a card's stuck job: cancel it through the broker and clear the claim",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: requireContainer(async (_opts, ctx, args) => {
        const cardId = String(args[0]);

        const pgBoss = ctx.container.get(PgBoss);
        await pgBoss.start();
        try {
            const cardJobs = ctx.container.get(CardJobs);
            const broker = ctx.container.get(JobBroker);

            // `inFlight` is also the reconciler: a claim whose job has already settled is cleared
            // as a side effect and reported here the same as no claim at all — there is nothing left
            // for this command to release either way.
            const jobId = await cardJobs.inFlight(cardId);
            if (!jobId) {
                ctx.logger.error(`${cardId} holds no claim — nothing to release`);
                return 1;
            }

            // Only a card that does hold a live claim needs disambiguating: is that claim genuinely
            // being worked right now, or just abandoned? See the module doc for why this comes after
            // `inFlight` rather than before it.
            const daemonPid = await runningDaemon();
            if (daemonPid) {
                ctx.logger.error(`${cardId}: job ${jobId} is claimed and daemon ${daemonPid} is running — it may genuinely be in flight`);
                ctx.logger.error('stop the daemon before releasing, or wait for it to finish');
                return 1;
            }

            const job = await broker.getJob('card.stage', jobId);
            ctx.logger.info(`${cardId}: job ${jobId} is ${job?.state ?? 'unknown'} — cancelling`);

            // Cancel, not delete: a cancelled job leaves a record behind that explains the gap in
            // the card's history; a deleted one leaves nothing.
            await broker.cancel('card.stage', jobId);
            await cardJobs.clear(cardId);

            ctx.logger.info(`${cardId}: released — job ${jobId} cancelled, claim cleared`);
            ctx.logger.info('the card itself has not moved; decide where it goes next with `wilson card move`.');
            return 0;
        } finally {
            await pgBoss.stop();
        }
    }),
};

export default command;
