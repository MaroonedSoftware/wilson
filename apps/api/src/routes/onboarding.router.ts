import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { OnboardingService } from '#modules/authentication/onboarding.service.js';
import { CreateAccountRequest, OnboardingStatus } from '../generated/onboarding.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [onboarding.ck](../../data/contracts/onboarding.ck)
 */
export const OnboardingRouter = ServerKitRouter();

/**
 * from [onboarding.ck](../../data/contracts/onboarding.ck) `GET /api/onboarding`
 * anonymous access, no security required
 */
OnboardingRouter.get('/api/onboarding', async ctx => {
    const service = ctx.container.get(OnboardingService);
    const result: OnboardingStatus = await service.status();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [onboarding.ck](../../data/contracts/onboarding.ck) `POST /api/onboarding`
 * anonymous access, no security required
 */
OnboardingRouter.post('/api/onboarding', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateAccountRequest);

    const service = ctx.container.get(OnboardingService);
    const result: OnboardingStatus = await service.createAccount(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});
