import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { CardStageConcurrencySettingService } from '#modules/settings/card.stage.concurrency.setting.service.js';
import { NotifyWebhookSettingService } from '#modules/settings/notify.webhook.setting.service.js';
import { PollerIntervalSettingService } from '#modules/settings/poller.interval.setting.service.js';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import {
    CardStageConcurrency,
    NotifyWebhookSetting,
    PollerInterval,
    PollerSetting,
    SetCardStageConcurrencyRequest,
    SetNotifyWebhookSettingRequest,
    SetPollerIntervalRequest,
    SetPollerSettingRequest,
} from '../generated/settings.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [settings.ck](file://./../../data/contracts/settings.ck)
 */
export const SettingsRouter = ServerKitRouter();

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L68)
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
 * from [settings.ck](file://./../../data/contracts/settings.ck#L75)
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
 * from [settings.ck](file://./../../data/contracts/settings.ck#L88)
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
 * from [settings.ck](file://./../../data/contracts/settings.ck#L95)
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
 * from [settings.ck](file://./../../data/contracts/settings.ck#L111)
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
 * from [settings.ck](file://./../../data/contracts/settings.ck#L118)
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

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L148)
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/notify-webhook', async ctx => {
    const service = ctx.container.get(NotifyWebhookSettingService);
    const result: NotifyWebhookSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](file://./../../data/contracts/settings.ck#L155)
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/notify-webhook', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetNotifyWebhookSettingRequest);

    const service = ctx.container.get(NotifyWebhookSettingService);
    const result: NotifyWebhookSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
