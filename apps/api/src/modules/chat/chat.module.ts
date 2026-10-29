import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { ApiChatEngine } from './api.chat.engine.js';
import { ChatCatalog } from './chat.catalog.js';
import { CHAT_ENGINE } from './chat.engine.setting.js';
import { ChatEngineSettingService } from './chat.engine.setting.service.js';
import { ChatMessageRepository } from './chat.message.repository.js';
import { ChatPendingActionRepository } from './chat.pending.action.repository.js';
import { ChatService } from './chat.service.js';
import { ChatThreadRepository } from './chat.thread.repository.js';
import { CliChatEngine } from './cli.chat.engine.js';

/**
 * The chat a person drives Wilson from, modelled on ats's web chat: an agent that reads through the
 * operation catalog (`McpModule`, reached through `ChatCatalog`) and proposes changes for the person
 * to confirm. Its conversations are kept in threads, messages and pending actions
 * (`data/migrations/20261029120000_chat.sql`).
 */
export const ChatModule: ServerKitModule = {
    name: 'Chat',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ChatThreadRepository).useClass(ChatThreadRepository).asTransient();
        registry.register(ChatMessageRepository).useClass(ChatMessageRepository).asTransient();
        registry.register(ChatPendingActionRepository).useClass(ChatPendingActionRepository).asTransient();
        registry.register(ChatCatalog).useClass(ChatCatalog).asSingleton();
        registry.register(ApiChatEngine).useClass(ApiChatEngine).asTransient();
        registry.register(CliChatEngine).useClass(CliChatEngine).asTransient();
        registry.register(ChatEngineSettingService).useClass(ChatEngineSettingService).asTransient();
        // A factory, not `useClass`: the service runs each catalog operation in a fresh scope of the
        // container itself (`ChatCatalog.run`), and the container is not a token it could inject.
        registry
            .register(ChatService)
            .useFactory(
                container =>
                    new ChatService(
                        container,
                        container.get(Logger),
                        container.get(ChatThreadRepository),
                        container.get(ChatMessageRepository),
                        container.get(ChatPendingActionRepository),
                        container.get(ChatCatalog),
                        container.get(ProjectRepository),
                        { api: container.get(ApiChatEngine), cli: container.get(CliChatEngine) },
                        () => container.get(SettingsStore).get(CHAT_ENGINE),
                    ),
            )
            .asTransient();
    },
};
