import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import { PollerSetting, SetPollerSettingRequest } from '../generated/settings.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [settings.ck](file://./../../data/contracts/settings.ck)
 */
export const SettingsRouter = ServerKitRouter();

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L28)
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/poller-enabled', async ctx => {
    const service = ctx.container.get(PollerSettingService);
    const result: PollerSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L35)
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/poller-enabled', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetPollerSettingRequest);

    const service = ctx.container.get(PollerSettingService);
    const result: PollerSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
