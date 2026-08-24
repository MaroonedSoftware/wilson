import { ServerKitRouter } from '@maroonedsoftware/koa';
import { HealthService } from '#modules/health/health.service.js';
import { Health } from './health.js';

/**
 * generated from [health.ck](file://./../../data/contracts/health.ck)
 */
export const HealthRouter = ServerKitRouter();

/**
 * from [health.ck](file://./../../data/contracts/health.ck#L18)
 * anonymous access, no security required
 */
HealthRouter.get('/api/health', async ctx => {
    const service = ctx.container.get(HealthService);
    const result: Health = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
