import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { AutoPlanSettingService } from '#modules/settings/auto.plan.setting.service.js';
import { AutoSplitSettingService } from '#modules/settings/auto.split.setting.service.js';
import { CardStageConcurrencySettingService } from '#modules/settings/card.stage.concurrency.setting.service.js';
import { ChatEngineSettingService } from '#modules/chat/chat.engine.setting.service.js';
import { ClaudeConfigDirSettingService } from '#modules/settings/claude.config.dir.setting.service.js';
import { DrainSettingService } from '#modules/settings/drain.setting.service.js';
import { DryRunSettingService } from '#modules/settings/dry.run.setting.service.js';
import { EngineTokenSettingService } from '#modules/settings/engine.token.setting.service.js';
import { GitHubAppSettingService } from '#modules/settings/github.app.setting.service.js';
import { LocalStageSlotsSettingService } from '#modules/settings/local.stage.slots.setting.service.js';
import { MergePullRequestSettingService } from '#modules/settings/merge.pull.request.setting.service.js';
import { NotifyWebhookSettingService } from '#modules/settings/notify.webhook.setting.service.js';
import { OrchestratorSettingService } from '#modules/settings/orchestrator.setting.service.js';
import { PollerIntervalSettingService } from '#modules/settings/poller.interval.setting.service.js';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import { RuleJudgeSettingService } from '#modules/rules/rule.judge.setting.service.js';
import {
    AutoPlanSetting,
    AutoSplitSetting,
    CardStageConcurrency,
    ChatEngineSetting,
    ClaudeConfigDirSetting,
    DrainStatus,
    DryRunSetting,
    EngineTokenSetting,
    GitHubAppSetting,
    LocalStageSlots,
    MergePullRequestSetting,
    NotifyWebhookSetting,
    OrchestratorSetting,
    PollerInterval,
    PollerSetting,
    RuleJudgeSetting,
    SetAutoPlanSettingRequest,
    SetAutoSplitSettingRequest,
    SetCardStageConcurrencyRequest,
    SetClaudeConfigDirSettingRequest,
    SetDrainRequest,
    SetDryRunSettingRequest,
    SetEngineTokenSettingRequest,
    SetGitHubAppSettingRequest,
    SetLocalStageSlotsRequest,
    SetMergePullRequestSettingRequest,
    SetNotifyWebhookSettingRequest,
    SetOrchestratorSettingRequest,
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
 */
SettingsRouter.get('/api/settings/poller-enabled', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(PollerSettingService);
    const result: PollerSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/poller-enabled`
 */
SettingsRouter.put('/api/settings/poller-enabled', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetPollerSettingRequest);

    const service = ctx.container.get(PollerSettingService);
    const result: PollerSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/drain`
 */
SettingsRouter.get('/api/settings/drain', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(DrainSettingService);
    const result: DrainStatus = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/drain`
 */
SettingsRouter.put('/api/settings/drain', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetDrainRequest);

    const service = ctx.container.get(DrainSettingService);
    const result: DrainStatus = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/poller-interval-ms`
 */
SettingsRouter.get('/api/settings/poller-interval-ms', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(PollerIntervalSettingService);
    const result: PollerInterval = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/poller-interval-ms`
 */
SettingsRouter.put('/api/settings/poller-interval-ms', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetPollerIntervalRequest);

    const service = ctx.container.get(PollerIntervalSettingService);
    const result: PollerInterval = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/card-stage-concurrency`
 */
SettingsRouter.get('/api/settings/card-stage-concurrency', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(CardStageConcurrencySettingService);
    const result: CardStageConcurrency = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/card-stage-concurrency`
 */
SettingsRouter.put('/api/settings/card-stage-concurrency', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetCardStageConcurrencyRequest);

    const service = ctx.container.get(CardStageConcurrencySettingService);
    const result: CardStageConcurrency = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/notify-webhook`
 */
SettingsRouter.get('/api/settings/notify-webhook', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(NotifyWebhookSettingService);
    const result: NotifyWebhookSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/notify-webhook`
 */
SettingsRouter.put('/api/settings/notify-webhook', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetNotifyWebhookSettingRequest);

    const service = ctx.container.get(NotifyWebhookSettingService);
    const result: NotifyWebhookSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/claude-config-dir`
 */
SettingsRouter.get('/api/settings/claude-config-dir', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(ClaudeConfigDirSettingService);
    const result: ClaudeConfigDirSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/claude-config-dir`
 */
SettingsRouter.put('/api/settings/claude-config-dir', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetClaudeConfigDirSettingRequest);

    const service = ctx.container.get(ClaudeConfigDirSettingService);
    const result: ClaudeConfigDirSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/engine-token`
 */
SettingsRouter.get('/api/settings/engine-token', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(EngineTokenSettingService);
    const result: EngineTokenSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/engine-token`
 */
SettingsRouter.put('/api/settings/engine-token', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetEngineTokenSettingRequest);

    const service = ctx.container.get(EngineTokenSettingService);
    const result: EngineTokenSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/dry-run`
 */
SettingsRouter.get('/api/settings/dry-run', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(DryRunSettingService);
    const result: DryRunSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/dry-run`
 */
SettingsRouter.put('/api/settings/dry-run', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetDryRunSettingRequest);

    const service = ctx.container.get(DryRunSettingService);
    const result: DryRunSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/auto-split`
 */
SettingsRouter.get('/api/settings/auto-split', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(AutoSplitSettingService);
    const result: AutoSplitSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/auto-split`
 */
SettingsRouter.put('/api/settings/auto-split', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetAutoSplitSettingRequest);

    const service = ctx.container.get(AutoSplitSettingService);
    const result: AutoSplitSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/merge-pull-request`
 */
SettingsRouter.get('/api/settings/merge-pull-request', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(MergePullRequestSettingService);
    const result: MergePullRequestSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/merge-pull-request`
 */
SettingsRouter.put('/api/settings/merge-pull-request', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetMergePullRequestSettingRequest);

    const service = ctx.container.get(MergePullRequestSettingService);
    const result: MergePullRequestSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/auto-plan`
 */
SettingsRouter.get('/api/settings/auto-plan', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(AutoPlanSettingService);
    const result: AutoPlanSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/auto-plan`
 */
SettingsRouter.put('/api/settings/auto-plan', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetAutoPlanSettingRequest);

    const service = ctx.container.get(AutoPlanSettingService);
    const result: AutoPlanSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/rule-judge`
 */
SettingsRouter.get('/api/settings/rule-judge', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(RuleJudgeSettingService);
    const result: RuleJudgeSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/rule-judge`
 */
SettingsRouter.put('/api/settings/rule-judge', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, RuleJudgeSetting);

    const service = ctx.container.get(RuleJudgeSettingService);
    const result: RuleJudgeSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/chat-engine`
 */
SettingsRouter.get('/api/settings/chat-engine', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(ChatEngineSettingService);
    const result: ChatEngineSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/chat-engine`
 */
SettingsRouter.put('/api/settings/chat-engine', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
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
 */
SettingsRouter.get('/api/settings/local-stage-slots', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(LocalStageSlotsSettingService);
    const result: LocalStageSlots = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * Read on every dispatch, so a write takes effect on the next stage; nothing to restart.
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/local-stage-slots`
 */
SettingsRouter.put('/api/settings/local-stage-slots', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetLocalStageSlotsRequest);

    const service = ctx.container.get(LocalStageSlotsSettingService);
    const result: LocalStageSlots = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/github-app`
 */
SettingsRouter.get('/api/settings/github-app', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(GitHubAppSettingService);
    const result: GitHubAppSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/github-app`
 */
SettingsRouter.put('/api/settings/github-app', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetGitHubAppSettingRequest);

    const service = ctx.container.get(GitHubAppSettingService);
    const result: GitHubAppSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `GET /api/settings/orchestrator`
 */
SettingsRouter.get('/api/settings/orchestrator', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(OrchestratorSettingService);
    const result: OrchestratorSetting = await service.get();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [settings.ck](../../data/contracts/settings.ck) `PUT /api/settings/orchestrator`
 */
SettingsRouter.put('/api/settings/orchestrator', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, SetOrchestratorSettingRequest);

    const service = ctx.container.get(OrchestratorSettingService);
    const result: OrchestratorSetting = await service.set(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});
