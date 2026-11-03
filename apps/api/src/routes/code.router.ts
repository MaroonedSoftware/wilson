import { ServerKitRouter, requirePolicy } from '@maroonedsoftware/koa';
import { CodeService } from '#modules/code/code.service.js';
import { CodeFilePage, CodeListQuery, CodeListing, CodeReadQuery, CodeSearchQuery, CodeSearchResult } from '../generated/code.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [code.ck](../../data/contracts/code.ck)
 */
export const CodeRouter = ServerKitRouter();

/**
 * from [code.ck](../../data/contracts/code.ck) `GET /api/code/tree`
 */
CodeRouter.get('/api/code/tree', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, CodeListQuery.strict());

    const service = ctx.container.get(CodeService);
    const result: CodeListing = await service.list(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [code.ck](../../data/contracts/code.ck) `GET /api/code/file`
 */
CodeRouter.get('/api/code/file', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, CodeReadQuery.strict());

    const service = ctx.container.get(CodeService);
    const result: CodeFilePage = await service.read(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [code.ck](../../data/contracts/code.ck) `GET /api/code/search`
 */
CodeRouter.get('/api/code/search', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, CodeSearchQuery.strict());

    const service = ctx.container.get(CodeService);
    const result: CodeSearchResult = await service.search(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
