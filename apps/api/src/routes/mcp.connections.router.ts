import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { McpConnectionsService } from '#modules/connections/mcp.connections.service.js';
import { McpConnection, PutMcpConnectionRequest, ReviewMcpToolsRequest } from '../generated/mcp.connections.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [mcp.connections.ck](../../data/contracts/mcp.connections.ck)
 */
export const McpConnectionsRouter = ServerKitRouter();

/**
 * from [mcp.connections.ck](../../data/contracts/mcp.connections.ck) `GET /api/mcp-connections`
 */
McpConnectionsRouter.get('/api/mcp-connections', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(McpConnectionsService);
    const result: McpConnection[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Connect to a server and list its tools, saving nothing if that fails. Replaces any connection saved
 * under `name`. A new address forgets every review, since it may be another server. No tool is
 * usable until it is reviewed.
 * from [mcp.connections.ck](../../data/contracts/mcp.connections.ck) `PUT /api/mcp-connections/{name}`
 */
McpConnectionsRouter.put('/api/mcp-connections/:name', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PutMcpConnectionRequest);

    const service = ctx.container.get(McpConnectionsService);
    const result: McpConnection = await service.put(name, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [mcp.connections.ck](../../data/contracts/mcp.connections.ck) `DELETE /api/mcp-connections/{name}`
 */
McpConnectionsRouter.delete('/api/mcp-connections/:name', requirePolicy({ policy: 'wilson.step.up' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(McpConnectionsService);
    await service.remove(name);

    ctx.status = 204;
});

/**
 * List the server's tools again. Anything it now describes differently stops being usable until it is
 * reviewed. Lowered to `wilson.manage`, since this can only take authority away.
 * from [mcp.connections.ck](../../data/contracts/mcp.connections.ck) `POST /api/mcp-connections/{name}/refresh`
 */
McpConnectionsRouter.post('/api/mcp-connections/:name/refresh', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { name } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            name: z.string(),
        }),
    );

    const service = ctx.container.get(McpConnectionsService);
    const result: McpConnection = await service.refresh(name);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Decide how each named tool may be used, approving what it is described as now. Tools left out stay
 * as they are.
 * from [mcp.connections.ck](../../data/contracts/mcp.connections.ck) `PUT /api/mcp-connections/{name}/tools`
 */
McpConnectionsRouter.put(
    '/api/mcp-connections/:name/tools',
    requirePolicy({ policy: 'wilson.step.up' }),
    bodyParserMiddleware(['json']),
    async ctx => {
        const { name } = await parseAndValidate(
            ctx.params,
            z.strictObject({
                name: z.string(),
            }),
        );

        const body = await parseAndValidate(ctx.parsedBody, ReviewMcpToolsRequest);

        const service = ctx.container.get(McpConnectionsService);
        const result: McpConnection = await service.review(name, body);

        ctx.status = 200;
        ctx.type = 'application/json';
        ctx.body = result;
    },
);
