import { describe, expect, it } from 'vitest';
import { CHAT_ENGINE, DEFAULT_CHAT_ENGINE } from '#modules/chat/chat.engine.setting.js';
import { ChatEngineSettingService } from '#modules/chat/chat.engine.setting.service.js';
import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/** A settings store holding one value per key in memory, falling back to each setting's default. */
const memoryStore = () => {
    const values = new Map<string, unknown>();
    return {
        values,
        store: {
            get: async <T>(definition: SettingDefinition<T>) =>
                (values.has(definition.key) ? values.get(definition.key) : definition.defaultValue) as T,
            set: async <T>(definition: SettingDefinition<T>, value: T) => void values.set(definition.key, value),
        } as unknown as SettingsStore,
    };
};

describe('the chat-engine setting', () => {
    it("defaults to the 'cli' engine, which needs no API key", async () => {
        const { store } = memoryStore();

        expect(await new ChatEngineSettingService(store).get()).toEqual(DEFAULT_CHAT_ENGINE);
        expect(DEFAULT_CHAT_ENGINE.engine).toBe('cli');
    });

    it('is deployment-scoped, since a thread is not tied to a project', () => {
        expect(CHAT_ENGINE.scope).toBe('deployment');
    });

    it('saves a choice with its model trimmed, and answers what it saved', async () => {
        const { store, values } = memoryStore();

        const saved = await new ChatEngineSettingService(store).set({ engine: 'api', provider: 'openai', model: '  gpt-6  ' });

        expect(saved).toEqual({ engine: 'api', provider: 'openai', model: 'gpt-6' });
        expect(values.get('chat-engine')).toEqual(saved);
    });

    it('refuses an empty model, saving nothing', async () => {
        const { store, values } = memoryStore();

        const failure = await new ChatEngineSettingService(store).set({ engine: 'cli', provider: 'anthropic', model: ' ' }).catch(err => err);

        expect(failure.details).toEqual({ reason: 'a model is required' });
        expect(values.size).toBe(0);
    });

    it('reads an engine name alone from the environment, with the default model', () => {
        expect(CHAT_ENGINE.parseEnv('api')).toEqual({ ...DEFAULT_CHAT_ENGINE, engine: 'api' });
        expect(CHAT_ENGINE.parseEnv('anything else')).toEqual({ ...DEFAULT_CHAT_ENGINE, engine: 'cli' });
    });
});
