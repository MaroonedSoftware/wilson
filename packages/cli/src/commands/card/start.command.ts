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
