import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { CurrentSessionService } from '#modules/authentication/current.session.service.js';
import { TokenService } from '#modules/authentication/token.service.js';
import { CurrentSession, PasskeyChallenge, PasskeyChallengeRequest, TokenRequest, TokenResponse } from '../generated/auth.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [auth.ck](../../data/contracts/auth.ck)
 */
export const AuthRouter = ServerKitRouter();

/**
 * from [auth.ck](../../data/contracts/auth.ck) `POST /api/auth/token`
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
 * The passkey half of the second step: a challenge for the browser to sign, issued against the
 * sign-in the password started. `security: none`, like `token`: the pending sign-in's challenge is
 * what authorizes it, and it is good for one sign-in.
 * from [auth.ck](../../data/contracts/auth.ck) `POST /api/auth/passkey/challenge`
 * anonymous access, no security required
 */
AuthRouter.post('/api/auth/passkey/challenge', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, PasskeyChallengeRequest);

    const service = ctx.container.get(TokenService);
    const result: PasskeyChallenge = await service.startPasskeyChallenge(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [auth.ck](../../data/contracts/auth.ck) `GET /api/auth/session`
 */
AuthRouter.get('/api/auth/session', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(CurrentSessionService);
    const result: CurrentSession = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [auth.ck](../../data/contracts/auth.ck) `POST /api/auth/logout`
 * anonymous access, no security required
 */
AuthRouter.post('/api/auth/logout', async ctx => {
    const service = ctx.container.get(CurrentSessionService);
    await service.logout();

    ctx.status = 204;
});
