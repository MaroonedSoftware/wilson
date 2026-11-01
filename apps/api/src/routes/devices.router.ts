import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { DevicesService } from '#modules/notify/devices.service.js';
import { RegisterDeviceRequest, UnregisterDeviceRequest } from '../generated/devices.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [devices.ck](../../data/contracts/devices.ck)
 */
export const DevicesRouter = ServerKitRouter();

/**
 * from [devices.ck](../../data/contracts/devices.ck) `POST /api/devices`
 */
DevicesRouter.post('/api/devices', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, RegisterDeviceRequest);

    const service = ctx.container.get(DevicesService);
    await service.register(body);

    ctx.status = 204;
});

/**
 * from [devices.ck](../../data/contracts/devices.ck) `POST /api/devices/unregister`
 */
DevicesRouter.post('/api/devices/unregister', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, UnregisterDeviceRequest);

    const service = ctx.container.get(DevicesService);
    await service.unregister(body);

    ctx.status = 204;
});
