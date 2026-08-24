import { ServerKitRouter } from '@maroonedsoftware/koa';
import { BoardConfig } from '#modules/board/board.config.js';
import { git } from '#modules/board/git.js';

/**
 * `GET /api/health` — names its own build.
 *
 * This project lost three runs to a daemon quietly serving stale code while a redeploy had already
 * landed. `head` is not decoration: it's the git HEAD the process was actually built from, so a
 * stale daemon is visible from one curl call instead of a lost run.
 */
export const healthRouter = ServerKitRouter();

healthRouter.get('/api/health', async ctx => {
    const boardConfig = ctx.container.get(BoardConfig);
    const { stdout } = await git(boardConfig.codeRoot, ['rev-parse', '--short', 'HEAD']);
    ctx.body = { ok: true, project: boardConfig.project, head: stdout.trim() };
});
