import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { generateText } from 'ai';
import { Injectable } from 'injectkit';
import { stageUsageOf } from '#modules/agent/budget.js';
import { subscriptionEnv } from '#modules/agent/cli.stage.agent.js';
import { ModelRegistry, type Provider } from '#modules/agent/model.registry.js';
import { describeUsageLimit, UsageLimitWatch } from '#modules/agent/usage.limit.js';
import { EngineAccountsService, LOCAL_ACCOUNT } from '#modules/host/engine.accounts.service.js';
import { CLAUDE_CONFIG_DIR } from '#modules/settings/claude.config.dir.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';

/** A verdict is one short JSON object, so this only stops a model that will not stop. */
const MAX_OUTPUT_TOKENS = 1500;

export interface RuleJudgeUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
}

export interface RuleJudgeCall {
    system: string;
    prompt: string;
    provider: Provider;
    model: string;
    signal: AbortSignal;
}

export interface RuleJudgeReply {
    text: string;
    usage?: RuleJudgeUsage;
}

/**
 * One fresh, tool-less model call, on one engine. A judge reads only what it is handed, so nothing in
 * the tree it is judging can reach it except through the diff, and it can change nothing.
 */
export abstract class RuleJudgeEngine {
    abstract ask(call: RuleJudgeCall): Promise<RuleJudgeReply>;
}

/** Keyed by the `rule-judge` setting's `engine`. */
export class RuleJudgeEngineMap extends Map<string, RuleJudgeEngine> {}

/** The AI SDK against a provider API key, the path `ApiChatEngine` runs on, with no tools at all. */
@Injectable()
export class ApiRuleJudgeEngine extends RuleJudgeEngine {
    constructor(private readonly models: ModelRegistry) {
        super();
    }

    async ask({ system, prompt, provider, model, signal }: RuleJudgeCall): Promise<RuleJudgeReply> {
        const result = await generateText({
            model: this.models.resolve(provider, model),
            instructions: system,
            prompt,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            abortSignal: signal,
        });
        return { text: result.text, usage: stageUsageOf(result.usage) };
    }
}

/**
 * The Claude Agent SDK on the operator's subscription (`subscriptionEnv`), the path `CliChatEngine` runs
 * on: `tools: []` turns every built-in tool off, `settingSources: []` with `strictMcpConfig` keeps the
 * host's own settings and MCP servers out, and one turn with no session kept is all a judge gets. A tool
 * the engine offers or reaches for anyway fails the call, since a judge's independence rests on it.
 */
@Injectable()
export class CliRuleJudgeEngine extends RuleJudgeEngine {
    constructor(
        private readonly settings: SettingsStore,
        private readonly accounts?: EngineAccountsService,
    ) {
        super();
    }

    async ask({ system, prompt, model, signal }: RuleJudgeCall): Promise<RuleJudgeReply> {
        const account = await this.accounts?.local();
        if (account?.limit) throw new Error(describeUsageLimit(account.limit));
        const usageWatch = new UsageLimitWatch(account?.name ?? LOCAL_ACCOUNT);

        const abortController = new AbortController();
        const abort = (): void => abortController.abort();
        if (signal.aborted) abort();
        signal.addEventListener('abort', abort, { once: true });

        const stream = query({
            prompt,
            options: {
                cwd: process.cwd(),
                model,
                systemPrompt: system,
                tools: [],
                mcpServers: {},
                settingSources: [],
                strictMcpConfig: true,
                maxTurns: 1,
                persistSession: false,
                abortController,
                env: subscriptionEnv(await this.settings.get(CLAUDE_CONFIG_DIR), account?.token, account?.variable),
            },
        });

        let written = '';
        try {
            for await (const message of stream) {
                usageWatch.observe(message);
                assertNoTools(message);
                if (message.type === 'assistant') {
                    written += message.message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
                } else if (message.type === 'result') {
                    if (usageWatch.limit) {
                        await this.accounts?.recordLimit(usageWatch.limit);
                        throw new Error(describeUsageLimit(usageWatch.limit));
                    }
                    if (message.subtype !== 'success') {
                        throw new Error(`the engine stopped (${message.subtype}): ${message.errors.join('; ') || 'no reason given'}`);
                    }
                    const read = message.usage.cache_read_input_tokens ?? 0;
                    const created = message.usage.cache_creation_input_tokens ?? 0;
                    return {
                        text: written,
                        usage: {
                            inputTokens: message.usage.input_tokens,
                            cachedInputTokens: read + created,
                            cacheWriteInputTokens: created,
                            outputTokens: message.usage.output_tokens,
                        },
                    };
                }
            }
        } finally {
            signal.removeEventListener('abort', abort);
        }
        throw new Error('the engine ended without a result');
    }
}

const assertNoTools = (message: SDKMessage): void => {
    const names =
        message.type === 'system' && message.subtype === 'init'
            ? message.tools
            : message.type === 'assistant'
              ? message.message.content.flatMap(part => (part.type === 'tool_use' ? [part.name] : []))
              : [];
    if (names.length > 0) throw new Error(`the engine offered or reached for tools a judge is not given: ${names.join(', ')}`);
};
