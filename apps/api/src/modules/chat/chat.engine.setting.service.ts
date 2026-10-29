import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { ChatEngineSetting } from '#src/generated/settings.js';
import { CHAT_ENGINE, invalidChatEngine } from './chat.engine.setting.js';

/** The `chat-engine` setting's contract surface (`settings.ck`). See `chat.engine.setting.ts`. */
@Injectable()
export class ChatEngineSettingService {
    constructor(private readonly settings: SettingsStore) {}

    async get(): Promise<ChatEngineSetting> {
        return this.settings.get(CHAT_ENGINE);
    }

    async set(body: ChatEngineSetting): Promise<ChatEngineSetting> {
        const choice = { ...body, model: body.model.trim() };
        const invalid = invalidChatEngine(choice);
        if (invalid) throw httpError(400).withDetails({ reason: invalid });
        await this.settings.set(CHAT_ENGINE, choice);
        return choice;
    }
}
