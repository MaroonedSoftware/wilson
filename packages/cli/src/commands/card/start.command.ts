import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Enqueue a card's current stage on the job queue.
 *
 * Enqueues and returns — it does not run the stage itself. The dispatchability check, the in-flight
 * claim check, and the enqueue itself all happen behind `POST /api/cards/:id/start` now
 * (`BoardWriteService.start`, card 0080), which no longer needs the CLI's old `PgBoss.start()`/
 * `stop()` dance: the API already runs `JobsModule.start` (its full ServerKit lifecycle connects
 * pg-boss), so a request reaching this endpoint finds the broker already connected. The API server is
 * the only process that holds a `JobRunner` now (card 0079) — `JobsModule.start` runs it whenever the
 * server boots — and that is what actually picks the job up and runs it; this command does not have
 * to stay alive for that to happen, and the wire contract no longer carries a job id to report back.
 *
 * Card 0104: this command has no scope-overlap warning left to keep in sync with the deferral
 * `CardStageJob.deferOnScopeConflict` now applies on every dispatch
 * (`apps/api/src/modules/jobs/card.stage.job.ts`) — card 0078/0080's rewrite already dropped it from
 * here, and `CardSummary`/`CardDetail` (`packages/sdk/src/types/board.ts`) expose neither another
 * card's "Files in scope" nor any in-flight indicator to recompute it from, so restoring it needs a
 * wire-contract change outside this card's scope. Enqueuing here still succeeds either way: a scope
 * conflict is caught server-side once the job actually dispatches, recorded as `dispatch.deferred`,
 * and the card runs once the collision clears — this command just has nothing early to warn with.
 */
const command: CommandModule = {
    description: "Enqueue a card's current stage on the job queue",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const card = await api.board.startCard(cardId);

        ctx.logger.info(`enqueued ${cardId} · ${card.stage}`);
        ctx.logger.info(
            'the job runs wherever the API is draining the queue — start it with `pnpm --filter @wilson/api start` if nothing is.',
        );
        return 0;
    }),
};

export default command;
