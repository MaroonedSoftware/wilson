import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { ProjectDirectoriesService } from '#modules/board/project.directories.service.js';
import { ProjectsService } from '#modules/board/projects.service.js';
import { CreateProjectRequest, DirectoryListing, DirectoryQuery, Project, UpdateProjectRequest } from '../generated/projects.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [projects.ck](../../data/contracts/projects.ck)
 */
export const ProjectsRouter = ServerKitRouter();

/**
 * No project header or `?project=` is required, and none is refused: `ProjectContextRouter`
 * (routes.setup.ts) only refuses a project that is *named and unregistered* — with neither set, it
 * falls back to the daemon's own configured project and calls `next`, the same as every other route
 * on this surface. That catch-all is already correct for a route that lists every project, so no
 * exemption was added for it.
 * from [projects.ck](../../data/contracts/projects.ck) `GET /api/projects`
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
 * from [projects.ck](../../data/contracts/projects.ck) `POST /api/projects`
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
 * from [projects.ck](../../data/contracts/projects.ck) `PATCH /api/projects/{name}`
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

/**
 * Lists folders on the daemon's machine, confined to the daemon user's home folder: a path outside
 * it (after resolving symlinks) is refused rather than listed. This is a new disclosure on an
 * unauthenticated surface, weighed the way `CreateProjectRequest`'s comment weighs accepting paths:
 * the API binds to 127.0.0.1, and anything that can reach it can already read the disk as this user.
 * The home-folder confinement is what keeps the listing to the part of the disk a project lives in.
 * Path segment, not a project: `/api/projects/{name}` has no `get`, so there is no clash.
 * from [projects.ck](../../data/contracts/projects.ck) `GET /api/projects/directories`
 * anonymous access, no security required
 */
ProjectsRouter.get('/api/projects/directories', async ctx => {
    const query = await parseAndValidate(ctx.query, DirectoryQuery.strict());

    const service = ctx.container.get(ProjectDirectoriesService);
    const result: DirectoryListing = await service.list(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
