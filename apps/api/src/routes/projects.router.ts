import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { ProjectsService } from '#modules/board/projects.service.js';
import { CreateProjectRequest, Project, UpdateProjectRequest } from '../generated/projects.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

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
 * from [projects.ck](file://./../../data/contracts/projects.ck#L81)
 * anonymous access, no security required
 */
ProjectsRouter.get('/api/projects', async ctx => {
    const service = ctx.container.get(ProjectsService);
    const result: Project[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Card 0168. Returns `Project` — the name alone, not the four paths just sent — the same
 * response shape `get` above answers with. Card 0162 withheld those four paths from an
 * unauthenticated read surface on purpose; echoing them back from a write would reverse that
 * quietly, for a caller that already has them. `ProjectsService.create` is where the path
 * validation and the duplicate-name refusal live.
 * from [projects.ck](file://./../../data/contracts/projects.ck#L95)
 * anonymous access, no security required
 */
ProjectsRouter.post('/api/projects', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateProjectRequest);

    const service = ctx.container.get(ProjectsService);
    const result: Project = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Not `put`. Fields present in the body are set; fields absent are left as they are — see
 * `UpdateProjectRequest`'s own comment, and `board.ck`'s `PATCH /api/cards/{id}` for the same
 * reasoning stated once and not repeated differently here.
 * from [projects.ck](file://./../../data/contracts/projects.ck#L125)
 * anonymous access, no security required
 */
ProjectsRouter.patch('/api/projects/:name', bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, UpdateProjectRequest);

    const service = ctx.container.get(ProjectsService);
    const result: Project = await service.update(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
