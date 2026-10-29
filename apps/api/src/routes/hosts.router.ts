import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { HostProber } from '#modules/host/host.prober.js';
import { HostsService } from '#modules/host/hosts.service.js';
import { CreateHostRequest, Host, PutHostProjectRequest, UpdateHostRequest } from '../generated/hosts.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [hosts.ck](../../data/contracts/hosts.ck)
 */
export const HostsRouter = ServerKitRouter();

/**
 * from [hosts.ck](../../data/contracts/hosts.ck) `GET /api/hosts`
 */
HostsRouter.get('/api/hosts', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(HostsService);
    const result: Host[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [hosts.ck](../../data/contracts/hosts.ck) `POST /api/hosts`
 */
HostsRouter.post('/api/hosts', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateHostRequest);

    const service = ctx.container.get(HostsService);
    const result: Host = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [hosts.ck](../../data/contracts/hosts.ck) `GET /api/hosts/{name}`
 */
HostsRouter.get('/api/hosts/:name', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(HostsService);
    const result: Host = await service.get(name);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [hosts.ck](../../data/contracts/hosts.ck) `PATCH /api/hosts/{name}`
 */
HostsRouter.patch('/api/hosts/:name', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, UpdateHostRequest);

    const service = ctx.container.get(HostsService);
    const result: Host = await service.update(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [hosts.ck](../../data/contracts/hosts.ck) `DELETE /api/hosts/{name}`
 */
HostsRouter.delete('/api/hosts/:name', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(HostsService);
    await service.remove(name);

    ctx.status = 204;
});

/**
 * Connect to the host and record what is there: that it can be reached, which `claude` it has, that each
 * project's clone is a git repository and its roots can be written, and, given a lifetime, when it
 * will stop. A failed check is a recorded result (`probe.ok: false`), not an error response.
 * from [hosts.ck](../../data/contracts/hosts.ck) `POST /api/hosts/{name}/probe`
 */
HostsRouter.post('/api/hosts/:name/probe', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(HostProber);
    const result: Host = await service.probe(name);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * `put`, not `patch`: a project on a host is its three paths together, and a half-set one would
 * cut worktrees from a clone that is not there.
 * from [hosts.ck](../../data/contracts/hosts.ck) `PUT /api/hosts/{name}/projects/{project}`
 */
HostsRouter.put('/api/hosts/:name/projects/:project', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { name, project } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
            project: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PutHostProjectRequest);

    const service = ctx.container.get(HostsService);
    const result: Host = await service.putProject(name, project, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * `put`, not `patch`: a project on a host is its three paths together, and a half-set one would
 * cut worktrees from a clone that is not there.
 * from [hosts.ck](../../data/contracts/hosts.ck) `DELETE /api/hosts/{name}/projects/{project}`
 */
HostsRouter.delete('/api/hosts/:name/projects/:project', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name, project } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
            project: z.string(),
        }),
    );

    const service = ctx.container.get(HostsService);
    await service.removeProject(name, project);

    ctx.status = 204;
});
