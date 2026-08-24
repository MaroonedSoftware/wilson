import { ServerKitRouter } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
import { buildHead } from '../server/build.info.js';

/**
 * `GET /api/health` — names its own build.
 *
 * This project lost three runs to a daemon quietly serving stale code while a redeploy had already
 * landed. `head` is not decoration: it is the commit captured at boot, so a process left up across a
 * merge reports the commit it is actually running rather than the one the repo has moved on to.
 * Reading it per request would report the new HEAD and make the stale daemon look current — the
 * precise failure this field exists to expose.
 */
export const healthRouter = ServerKitRouter();

healthRouter.get('/api/health', async ctx => {
    const boardConfig = ctx.container.get(BoardConfig);
    ctx.body = { ok: true, project: boardConfig.project, head: buildHead() };
});
