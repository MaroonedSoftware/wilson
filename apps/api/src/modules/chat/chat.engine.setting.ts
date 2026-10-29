import { PROVIDERS, type Provider } from '#modules/agent/model.registry.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import type { ChatEngineName } from './chat.thread.repository.js';

/** Which engine a new thread runs on, and the model every turn uses. */
export interface ChatEngineChoice {
    engine: ChatEngineName;
    /** The provider the 'api' engine resolves `model` through (`ModelRegistry`). 'cli' always runs Claude. */
    provider: Provider;
    model: string;
}

export const CHAT_ENGINES: readonly ChatEngineName[] = ['api', 'cli'];

export const DEFAULT_CHAT_ENGINE: ChatEngineChoice = { engine: 'cli', provider: 'anthropic', model: 'claude-sonnet-5-5' };

/**
 * The `chat-engine` setting: which engine new chat threads start on, and the model turns run on.
 * Deployment-scoped, like `claude-config-dir`: a thread is not project-scoped, so neither is the
 * engine that answers it.
 *
 * 'cli' by default, the Claude Agent SDK on the operator's subscription, the same path planning runs
 * on. It needs no API key; 'api' needs one for `provider` in `apps/api/.env`, and bills per token.
 * Changing it applies to threads started afterwards: a thread stays on the engine it started on,
 * since the two keep history differently (see `20261029120000_chat.sql`). The model applies to every
 * thread's next turn.
 *
 * `CHAT_ENGINE` in the environment names the engine alone ('api' or 'cli'), with the default model.
 */
export const CHAT_ENGINE: SettingDefinition<ChatEngineChoice> = {
    key: 'chat-engine',
    scope: 'deployment',
    envVar: 'CHAT_ENGINE',
    parseEnv: raw => ({ ...DEFAULT_CHAT_ENGINE, engine: raw.trim().toLowerCase() === 'api' ? 'api' : 'cli' }),
    defaultValue: DEFAULT_CHAT_ENGINE,
};

/** Why `choice` cannot be saved, or undefined when it can. */
export const invalidChatEngine = (choice: ChatEngineChoice): string | undefined => {
    if (!CHAT_ENGINES.includes(choice.engine)) return `engine must be one of ${CHAT_ENGINES.join(', ')}`;
    if (!PROVIDERS.includes(choice.provider)) return `provider must be one of ${PROVIDERS.join(', ')}`;
    if (!choice.model.trim()) return 'a model is required';
    return undefined;
};
