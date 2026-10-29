import { ServerKitRouter, bodyParserMiddleware } from '@maroonedsoftware/koa';
import { CardStageConcurrencySettingService } from '#modules/settings/card.stage.concurrency.setting.service.js';
import { ChatEngineSettingService } from '#modules/chat/chat.engine.setting.service.js';
import { ClaudeConfigDirSettingService } from '#modules/settings/claude.config.dir.setting.service.js';
import { DryRunSettingService } from '#modules/settings/dry.run.setting.service.js';
import { LocalStageSlotsSettingService } from '#modules/settings/local.stage.slots.setting.service.js';
import { NotifyWebhookSettingService } from '#modules/settings/notify.webhook.setting.service.js';
import { PollerIntervalSettingService } from '#modules/settings/poller.interval.setting.service.js';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import {
    CardStageConcurrency,
    ChatEngineSetting,
    ClaudeConfigDirSetting,
    DryRunSetting,
    LocalStageSlots,
    NotifyWebhookSetting,
    PollerInterval,
    PollerSetting,
    SetCardStageConcurrencyRequest,
    SetClaudeConfigDirSettingRequest,
    SetDryRunSettingRequest,
    SetLocalStageSlotsRequest,
    SetNotifyWebhookSettingRequest,
    SetPollerIntervalRequest,
    SetPollerSettingRequest,
} from '../generated/settings.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [settings.ck](../../data/contracts/settings.ck)
 */
export const SettingsRouter = ServerKitRouter();

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/poller-enabled`
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
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/poller-enabled`
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
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/poller-interval-ms`
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
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/poller-interval-ms`
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
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/card-stage-concurrency`
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
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/card-stage-concurrency`
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
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/notify-webhook`
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
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/notify-webhook`
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

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/claude-config-dir`
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/claude-config-dir', async ctx => {
    const service = ctx.container.get(ClaudeConfigDirSettingService);
    const result: ClaudeConfigDirSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/claude-config-dir`
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/claude-config-dir', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetClaudeConfigDirSettingRequest);

    const service = ctx.container.get(ClaudeConfigDirSettingService);
    const result: ClaudeConfigDirSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/dry-run`
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/dry-run', async ctx => {
    const service = ctx.container.get(DryRunSettingService);
    const result: DryRunSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/dry-run`
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/dry-run', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetDryRunSettingRequest);

    const service = ctx.container.get(DryRunSettingService);
    const result: DryRunSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/chat-engine`
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/chat-engine', async ctx => {
    const service = ctx.container.get(ChatEngineSettingService);
    const result: ChatEngineSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/chat-engine`
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/chat-engine', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, ChatEngineSetting);

    const service = ctx.container.get(ChatEngineSettingService);
    const result: ChatEngineSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Read on every dispatch, so a write takes effect on the next stage; nothing to restart.
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/local-stage-slots`
 * anonymous access, no security required
 */
SettingsRouter.get('/api/settings/local-stage-slots', async ctx => {
    const service = ctx.container.get(LocalStageSlotsSettingService);
    const result: LocalStageSlots = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Read on every dispatch, so a write takes effect on the next stage; nothing to restart.
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/local-stage-slots`
 * anonymous access, no security required
 */
SettingsRouter.put('/api/settings/local-stage-slots', bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetLocalStageSlotsRequest);

    const service = ctx.container.get(LocalStageSlotsSettingService);
    const result: LocalStageSlots = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
