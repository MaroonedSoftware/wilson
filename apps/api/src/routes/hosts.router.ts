import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { EngineTokensService } from '#modules/host/engine.tokens.service.js';
import { HostProber } from '#modules/host/host.prober.js';
import { HostsService } from '#modules/host/hosts.service.js';
import { WorkerTokensService } from '#modules/host/worker.tokens.service.js';
import {
    CreateHostRequest,
    Host,
    IssuedWorkerToken,
    PutHostEngineTokenRequest,
    PutHostProjectRequest,
    UpdateHostRequest,
} from '../generated/hosts.js';
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
 * Register a machine card stages can run on, reached over SSH or by a worker program that connects
 * in. A worker host then needs its token minted with `wilson host token` or on the web app's Hosts
 * page, which agents cannot do, and the worker started on the machine (`apps/worker/README.md`).
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
 * Say where a project lives on a host, which lets stages for it run there. Not needed for a
 * project a worker host's `projectsRoot` takes on by itself.
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
 * Stop serving a project from a host. Files already on the machine are left there.
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

/**
 * The one credential a worker host's worker program connects with. Only the worker endpoint accepts
 * it, and only as this host, so it grants less than the `manage` key or session minting it already
 * holds; that is why minting needs `wilson.manage` and not a step-up, which a CLI key cannot give.
 * `post` mints one, replacing any the host had, so rotating is posting again.
 * from [hosts.ck](../../data/contracts/hosts.ck) `POST /api/hosts/{name}/worker-token`
 */
HostsRouter.post('/api/hosts/:name/worker-token', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(WorkerTokensService);
    const result: IssuedWorkerToken = await service.issue(name);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * The one credential a worker host's worker program connects with. Only the worker endpoint accepts
 * it, and only as this host, so it grants less than the `manage` key or session minting it already
 * holds; that is why minting needs `wilson.manage` and not a step-up, which a CLI key cannot give.
 * `post` mints one, replacing any the host had, so rotating is posting again.
 * from [hosts.ck](../../data/contracts/hosts.ck) `DELETE /api/hosts/{name}/worker-token`
 */
HostsRouter.delete('/api/hosts/:name/worker-token', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(WorkerTokensService);
    await service.revoke(name);

    ctx.status = 204;
});

/**
 * Which saved engine token a worker host's engines sign in with. An operation of its own, not a field
 * on `PATCH /api/hosts/{name}`, so that choosing a credential stays out of an agent's reach. A change
 * reaches the next engine started there, never one already running.
 * from [hosts.ck](../../data/contracts/hosts.ck) `PUT /api/hosts/{name}/engine-token`
 */
HostsRouter.put('/api/hosts/:name/engine-token', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PutHostEngineTokenRequest);

    const service = ctx.container.get(EngineTokensService);
    const result: Host = await service.assign(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Back to the worker's own sign-in.
 * from [hosts.ck](../../data/contracts/hosts.ck) `DELETE /api/hosts/{name}/engine-token`
 */
HostsRouter.delete('/api/hosts/:name/engine-token', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(EngineTokensService);
    const result: Host = await service.unassign(name);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
