import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { CardStageConcurrencySettingService } from '#modules/settings/card.stage.concurrency.setting.service.js';
import { PollerIntervalSettingService } from '#modules/settings/poller.interval.setting.service.js';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import {
    CardStageConcurrency,
    PollerInterval,
    PollerSetting,
    SetCardStageConcurrencyRequest,
    SetPollerIntervalRequest,
    SetPollerSettingRequest,
} from '../generated/settings.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [settings.ck](file://./../../data/contracts/settings.ck)
 */
export const SettingsRouter = ServerKitRouter();

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L55)
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
 * from [settings.ck](file://./../../data/contracts/settings.ck#L62)
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

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L75)
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/poller-interval-ms', async ctx => {
    const service = ctx.container.get(PollerIntervalSettingService);
    const result: PollerInterval = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L82)
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/poller-interval-ms', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetPollerIntervalRequest);

    const service = ctx.container.get(PollerIntervalSettingService);
    const result: PollerInterval = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L98)
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/card-stage-concurrency', async ctx => {
    const service = ctx.container.get(CardStageConcurrencySettingService);
    const result: CardStageConcurrency = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L105)
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/card-stage-concurrency', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetCardStageConcurrencyRequest);

    const service = ctx.container.get(CardStageConcurrencySettingService);
    const result: CardStageConcurrency = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
