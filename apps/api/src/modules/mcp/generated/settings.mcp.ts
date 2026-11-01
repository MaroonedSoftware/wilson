// Auto-generated MCP tools
// generated from [settings.ck](../../../../data/contracts/settings.ck)
import { Injectable, type Container, type Registry } from 'injectkit';
import { z } from 'zod';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { requireMcpPolicy, type McpToolHandler, type McpToolHandlerMap, type McpToolContext } from '@maroonedsoftware/mcp';
import { PolicyService } from '@maroonedsoftware/policies';
import { parseAndValidate } from '@maroonedsoftware/zod';
import { AutoSplitSettingService } from '#modules/settings/auto.split.setting.service.js';
import { CardStageConcurrencySettingService } from '#modules/settings/card.stage.concurrency.setting.service.js';
import { ChatEngineSettingService } from '#modules/chat/chat.engine.setting.service.js';
import { ClaudeConfigDirSettingService } from '#modules/settings/claude.config.dir.setting.service.js';
import { DryRunSettingService } from '#modules/settings/dry.run.setting.service.js';
import { GitHubAppSettingService } from '#modules/settings/github.app.setting.service.js';
import { LocalStageSlotsSettingService } from '#modules/settings/local.stage.slots.setting.service.js';
import { NotifyWebhookSettingService } from '#modules/settings/notify.webhook.setting.service.js';
import { PollerIntervalSettingService } from '#modules/settings/poller.interval.setting.service.js';
import { PollerSettingService } from '#modules/settings/poller.setting.service.js';
import {
    AutoSplitSetting,
    CardStageConcurrency,
    ChatEngineSetting,
    ClaudeConfigDirSetting,
    DryRunSetting,
    GitHubAppSetting,
    LocalStageSlots,
    NotifyWebhookSetting,
    PollerInterval,
    PollerSetting,
    SetAutoSplitSettingRequest,
    SetCardStageConcurrencyRequest,
    SetClaudeConfigDirSettingRequest,
    SetDryRunSettingRequest,
    SetGitHubAppSettingRequest,
    SetLocalStageSlotsRequest,
    SetNotifyWebhookSettingRequest,
    SetPollerIntervalRequest,
    SetPollerSettingRequest,
} from '../../../generated/settings.js';

/** The request's scoped container, which a tool resolving per call reads its service and policies from. */
function requireMcpContainer(context: McpToolContext): Container {
    if (!context.container) {
        throw new Error(`MCP tool '${context.toolName}' needs the request container: pass \`container: ctx.container\` to createMcpRequestContext.`);
    }
    return context.container;
}

const GetPollerSettingArgs = z.object({});
const SetPollerSettingArgs = z.object({ body: SetPollerSettingRequest });
const GetPollerIntervalArgs = z.object({});
const SetPollerIntervalArgs = z.object({ body: SetPollerIntervalRequest });
const GetCardStageConcurrencyArgs = z.object({});
const SetCardStageConcurrencyArgs = z.object({ body: SetCardStageConcurrencyRequest });
const GetNotifyWebhookSettingArgs = z.object({});
const SetNotifyWebhookSettingArgs = z.object({ body: SetNotifyWebhookSettingRequest });
const GetClaudeConfigDirSettingArgs = z.object({});
const SetClaudeConfigDirSettingArgs = z.object({ body: SetClaudeConfigDirSettingRequest });
const GetDryRunSettingArgs = z.object({});
const SetDryRunSettingArgs = z.object({ body: SetDryRunSettingRequest });
const GetAutoSplitSettingArgs = z.object({});
const SetAutoSplitSettingArgs = z.object({ body: SetAutoSplitSettingRequest });
const GetChatEngineSettingArgs = z.object({});
const SetChatEngineSettingArgs = z.object({ body: ChatEngineSetting });
const GetLocalStageSlotsArgs = z.object({});
const SetLocalStageSlotsArgs = z.object({ body: SetLocalStageSlotsRequest });
const GetGithubAppSettingArgs = z.object({});
const SetGithubAppSettingArgs = z.object({ body: SetGitHubAppSettingRequest });

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/poller-enabled`
 */
@Injectable()
export class GetPollerSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_poller_setting',
        inputSchema: z.toJSONSchema(GetPollerSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(PollerSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(PollerSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/poller-enabled`
 */
@Injectable()
export class SetPollerSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_poller_setting',
        inputSchema: z.toJSONSchema(SetPollerSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(PollerSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetPollerSettingArgs);
        const result = await container.get(PollerSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/poller-interval-ms`
 */
@Injectable()
export class GetPollerIntervalMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_poller_interval',
        inputSchema: z.toJSONSchema(GetPollerIntervalArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(PollerInterval, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(PollerIntervalSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/poller-interval-ms`
 */
@Injectable()
export class SetPollerIntervalMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_poller_interval',
        inputSchema: z.toJSONSchema(SetPollerIntervalArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(PollerInterval, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetPollerIntervalArgs);
        const result = await container.get(PollerIntervalSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/card-stage-concurrency`
 */
@Injectable()
export class GetCardStageConcurrencyMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_card_stage_concurrency',
        inputSchema: z.toJSONSchema(GetCardStageConcurrencyArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardStageConcurrency, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(CardStageConcurrencySettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/card-stage-concurrency`
 */
@Injectable()
export class SetCardStageConcurrencyMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_card_stage_concurrency',
        inputSchema: z.toJSONSchema(SetCardStageConcurrencyArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(CardStageConcurrency, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetCardStageConcurrencyArgs);
        const result = await container.get(CardStageConcurrencySettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/notify-webhook`
 */
@Injectable()
export class GetNotifyWebhookSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_notify_webhook_setting',
        inputSchema: z.toJSONSchema(GetNotifyWebhookSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(NotifyWebhookSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(NotifyWebhookSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/notify-webhook`
 */
@Injectable()
export class SetNotifyWebhookSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_notify_webhook_setting',
        inputSchema: z.toJSONSchema(SetNotifyWebhookSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(NotifyWebhookSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetNotifyWebhookSettingArgs);
        const result = await container.get(NotifyWebhookSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/claude-config-dir`
 */
@Injectable()
export class GetClaudeConfigDirSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_claude_config_dir_setting',
        inputSchema: z.toJSONSchema(GetClaudeConfigDirSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(ClaudeConfigDirSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(ClaudeConfigDirSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/claude-config-dir`
 */
@Injectable()
export class SetClaudeConfigDirSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_claude_config_dir_setting',
        inputSchema: z.toJSONSchema(SetClaudeConfigDirSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(ClaudeConfigDirSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetClaudeConfigDirSettingArgs);
        const result = await container.get(ClaudeConfigDirSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/dry-run`
 */
@Injectable()
export class GetDryRunSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_dry_run_setting',
        inputSchema: z.toJSONSchema(GetDryRunSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(DryRunSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(DryRunSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/dry-run`
 */
@Injectable()
export class SetDryRunSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_dry_run_setting',
        inputSchema: z.toJSONSchema(SetDryRunSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(DryRunSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetDryRunSettingArgs);
        const result = await container.get(DryRunSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/auto-split`
 */
@Injectable()
export class GetAutoSplitSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_auto_split_setting',
        inputSchema: z.toJSONSchema(GetAutoSplitSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(AutoSplitSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(AutoSplitSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/auto-split`
 */
@Injectable()
export class SetAutoSplitSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_auto_split_setting',
        inputSchema: z.toJSONSchema(SetAutoSplitSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(AutoSplitSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetAutoSplitSettingArgs);
        const result = await container.get(AutoSplitSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/chat-engine`
 */
@Injectable()
export class GetChatEngineSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_chat_engine_setting',
        inputSchema: z.toJSONSchema(GetChatEngineSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(ChatEngineSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(ChatEngineSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/chat-engine`
 */
@Injectable()
export class SetChatEngineSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_chat_engine_setting',
        inputSchema: z.toJSONSchema(SetChatEngineSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(ChatEngineSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetChatEngineSettingArgs);
        const result = await container.get(ChatEngineSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/local-stage-slots`
 */
@Injectable()
export class GetLocalStageSlotsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_local_stage_slots',
        description: 'Read on every dispatch, so a write takes effect on the next stage; nothing to restart.',
        inputSchema: z.toJSONSchema(GetLocalStageSlotsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(LocalStageSlots, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(LocalStageSlotsSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/local-stage-slots`
 */
@Injectable()
export class SetLocalStageSlotsMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_local_stage_slots',
        description: 'Read on every dispatch, so a write takes effect on the next stage; nothing to restart.',
        inputSchema: z.toJSONSchema(SetLocalStageSlotsArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(LocalStageSlots, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetLocalStageSlotsArgs);
        const result = await container.get(LocalStageSlotsSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `GET /api/settings/github-app`
 */
@Injectable()
export class GetGithubAppSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'get_github_app_setting',
        inputSchema: z.toJSONSchema(GetGithubAppSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(GitHubAppSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.view' } },
    };

    async handle(_args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.view' });
        const result = await container.get(GitHubAppSettingService).get();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/**
 * from [settings.ck](../../../../data/contracts/settings.ck) `PUT /api/settings/github-app`
 */
@Injectable()
export class SetGithubAppSettingMcpTool implements McpToolHandler {
    readonly definition: Tool = {
        name: 'set_github_app_setting',
        inputSchema: z.toJSONSchema(SetGithubAppSettingArgs, { unrepresentable: 'any', io: 'input' }) as Tool['inputSchema'],
        outputSchema: z.toJSONSchema(GitHubAppSetting, { unrepresentable: 'any' }) as Tool['outputSchema'],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'contractkit/security': { policy: 'wilson.manage' } },
    };

    async handle(args: Record<string, unknown>, context: McpToolContext): Promise<CallToolResult> {
        const container = requireMcpContainer(context);
        await requireMcpPolicy(context, container.get(PolicyService), { policy: 'wilson.manage' });
        const { body } = await parseAndValidate(args, SetGithubAppSettingArgs);
        const result = await container.get(GitHubAppSettingService).set(body);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
}

/** Add a handler for each of this file's operations to the catalog, unlisted in `tools/list`. */
export function registerSettingsMcpCatalog(map: McpToolHandlerMap, container: Container): void {
    map.set('get_poller_setting', container.get(GetPollerSettingMcpTool));
    map.set('set_poller_setting', container.get(SetPollerSettingMcpTool));
    map.set('get_poller_interval', container.get(GetPollerIntervalMcpTool));
    map.set('set_poller_interval', container.get(SetPollerIntervalMcpTool));
    map.set('get_card_stage_concurrency', container.get(GetCardStageConcurrencyMcpTool));
    map.set('set_card_stage_concurrency', container.get(SetCardStageConcurrencyMcpTool));
    map.set('get_notify_webhook_setting', container.get(GetNotifyWebhookSettingMcpTool));
    map.set('set_notify_webhook_setting', container.get(SetNotifyWebhookSettingMcpTool));
    map.set('get_claude_config_dir_setting', container.get(GetClaudeConfigDirSettingMcpTool));
    map.set('set_claude_config_dir_setting', container.get(SetClaudeConfigDirSettingMcpTool));
    map.set('get_dry_run_setting', container.get(GetDryRunSettingMcpTool));
    map.set('set_dry_run_setting', container.get(SetDryRunSettingMcpTool));
    map.set('get_auto_split_setting', container.get(GetAutoSplitSettingMcpTool));
    map.set('set_auto_split_setting', container.get(SetAutoSplitSettingMcpTool));
    map.set('get_chat_engine_setting', container.get(GetChatEngineSettingMcpTool));
    map.set('set_chat_engine_setting', container.get(SetChatEngineSettingMcpTool));
    map.set('get_local_stage_slots', container.get(GetLocalStageSlotsMcpTool));
    map.set('set_local_stage_slots', container.get(SetLocalStageSlotsMcpTool));
    map.set('get_github_app_setting', container.get(GetGithubAppSettingMcpTool));
    map.set('set_github_app_setting', container.get(SetGithubAppSettingMcpTool));
}

/** Register this file's tool classes on the registry, so the tool maps can resolve them. */
export function registerSettingsMcpToolClasses(registry: Registry): void {
    registry.register(GetPollerSettingMcpTool).useClass(GetPollerSettingMcpTool).asSingleton();
    registry.register(SetPollerSettingMcpTool).useClass(SetPollerSettingMcpTool).asSingleton();
    registry.register(GetPollerIntervalMcpTool).useClass(GetPollerIntervalMcpTool).asSingleton();
    registry.register(SetPollerIntervalMcpTool).useClass(SetPollerIntervalMcpTool).asSingleton();
    registry.register(GetCardStageConcurrencyMcpTool).useClass(GetCardStageConcurrencyMcpTool).asSingleton();
    registry.register(SetCardStageConcurrencyMcpTool).useClass(SetCardStageConcurrencyMcpTool).asSingleton();
    registry.register(GetNotifyWebhookSettingMcpTool).useClass(GetNotifyWebhookSettingMcpTool).asSingleton();
    registry.register(SetNotifyWebhookSettingMcpTool).useClass(SetNotifyWebhookSettingMcpTool).asSingleton();
    registry.register(GetClaudeConfigDirSettingMcpTool).useClass(GetClaudeConfigDirSettingMcpTool).asSingleton();
    registry.register(SetClaudeConfigDirSettingMcpTool).useClass(SetClaudeConfigDirSettingMcpTool).asSingleton();
    registry.register(GetDryRunSettingMcpTool).useClass(GetDryRunSettingMcpTool).asSingleton();
    registry.register(SetDryRunSettingMcpTool).useClass(SetDryRunSettingMcpTool).asSingleton();
    registry.register(GetAutoSplitSettingMcpTool).useClass(GetAutoSplitSettingMcpTool).asSingleton();
    registry.register(SetAutoSplitSettingMcpTool).useClass(SetAutoSplitSettingMcpTool).asSingleton();
    registry.register(GetChatEngineSettingMcpTool).useClass(GetChatEngineSettingMcpTool).asSingleton();
    registry.register(SetChatEngineSettingMcpTool).useClass(SetChatEngineSettingMcpTool).asSingleton();
    registry.register(GetLocalStageSlotsMcpTool).useClass(GetLocalStageSlotsMcpTool).asSingleton();
    registry.register(SetLocalStageSlotsMcpTool).useClass(SetLocalStageSlotsMcpTool).asSingleton();
    registry.register(GetGithubAppSettingMcpTool).useClass(GetGithubAppSettingMcpTool).asSingleton();
    registry.register(SetGithubAppSettingMcpTool).useClass(SetGithubAppSettingMcpTool).asSingleton();
}
