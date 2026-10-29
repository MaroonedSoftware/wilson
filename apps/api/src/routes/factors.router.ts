import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { FactorsService } from '#modules/authentication/factors.service.js';
import { AuthenticatorRegistration, SecondFactorSummary, StartAuthenticatorRequest, VerifyAuthenticatorRequest } from '../generated/factors.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [factors.ck](file://./../../data/contracts/factors.ck)
 */
export const FactorsRouter = ServerKitRouter();

/**
 * from [factors.ck](file://./../../data/contracts/factors.ck#L49)
 */
FactorsRouter.get('/api/auth/factors', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(FactorsService);
    const result: SecondFactorSummary[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [factors.ck](file://./../../data/contracts/factors.ck#L65)
 */
FactorsRouter.post('/api/auth/factors/authenticator', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, StartAuthenticatorRequest);

    const service = ctx.container.get(FactorsService);
    const result: AuthenticatorRegistration = await service.startAuthenticator(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [factors.ck](file://./../../data/contracts/factors.ck#L83)
 */
FactorsRouter.post(
    '/api/auth/factors/authenticator/verify',
    requirePolicy({ policy: 'wilson.step.up' }),
    bodyParserMiddleware(['json']),
    async ctx => {
        const body = await parseAndValidate(ctx.parsedBody, VerifyAuthenticatorRequest);

        const service = ctx.container.get(FactorsService);
        const result: SecondFactorSummary = await service.verifyAuthenticator(body);

        ctx.status = 201;
        ctx.type = 'application/json';
        ctx.body = result;
    },
);

/**
 * from [factors.ck](file://./../../data/contracts/factors.ck#L105)
 */
FactorsRouter.delete('/api/auth/factors/:id', requirePolicy({ policy: 'wilson.step.up' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(FactorsService);
    await service.remove(id);

    ctx.status = 204;
});
