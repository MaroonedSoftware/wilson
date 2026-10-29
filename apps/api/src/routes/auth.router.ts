import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { CurrentSessionService } from '#modules/authentication/current.session.service.js';
import { TokenService } from '#modules/authentication/token.service.js';
import { CurrentSession, TokenRequest, TokenResponse } from '../generated/auth.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [auth.ck](file://./../../data/contracts/auth.ck)
 */
export const AuthRouter = ServerKitRouter();

/**
 * from [auth.ck](file://./../../data/contracts/auth.ck#L48)
 * anonymous access, no security required
 */
AuthRouter.post('/api/auth/token', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, TokenRequest);

    const service = ctx.container.get(TokenService);
    const result: TokenResponse = await service.requestToken(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [auth.ck](file://./../../data/contracts/auth.ck#L70)
 */
AuthRouter.get('/api/auth/session', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(CurrentSessionService);
    const result: CurrentSession = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [auth.ck](file://./../../data/contracts/auth.ck#L88)
 * anonymous access, no security required
 */
AuthRouter.post('/api/auth/logout', async ctx => {
    const service = ctx.container.get(CurrentSessionService);
    await service.logout();

    ctx.status = 204;
});
