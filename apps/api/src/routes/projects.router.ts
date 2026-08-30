import { ServerKitRouter } from '@maroonedsoftware/koa';
import { ProjectsService } from '#modules/board/projects.service.js';
import { Project } from '../generated/projects.js';

/**
 * generated from [projects.ck](file://./../../data/contracts/projects.ck)
 */
export const ProjectsRouter = ServerKitRouter();

/**
 * No project header or `?project=` is required, and none is refused: `ProjectContextRouter`
 * (routes.setup.ts) only refuses a project that is *named and unregistered* — with neither set, it
 * falls back to the daemon's own configured project and calls `next`, the same as every other route
 * on this surface. That catch-all is already correct for a route that lists every project, so no
 * exemption was added for it.
 * from [projects.ck](file://./../../data/contracts/projects.ck#L39)
 * anonymous access, no security required
 */
ProjectsRouter.get('/api/projects', async ctx => {
    const service = ctx.container.get(ProjectsService);
    const result: Project[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
