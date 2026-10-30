import { Registry, type Container } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitContext, ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { requireSession } from '#modules/authentication/request.session.js';
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
 * The root container, reachable from a request's scope. A singleton's factory is handed the root
 * whatever scope triggered it, which is the only way to come by it. A turn needs it because the
 * request scope is disposed when the response closes, and a follow-up always runs after that.
 */
class ChatRootContainer {
    constructor(readonly container: Container) {}
}

/**
 * The chat a person drives Wilson from, modelled on ats's web chat: an agent that reads through the
 * operation catalog (`McpModule`, reached through `ChatCatalog`) and proposes changes for the person
 * to confirm. Its conversations are kept in threads, messages and pending actions
 * (`data/migrations/20261029000900_chat.sql`).
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
        // The session is read when a turn needs it, not here: the service also resolves outside a
        // request, where `ServerKitContext` throws. That is the one thing it takes from the request's
        // scope once built; what a turn resolves comes from the root, which outlives the response.
        registry
            .register(ChatRootContainer)
            .useFactory(container => new ChatRootContainer(container))
            .asSingleton();
        registry
            .register(ChatService)
            .useFactory(container => {
                const root = container.get(ChatRootContainer).container;
                return new ChatService(
                    root,
                    container.get(Logger),
                    container.get(ChatThreadRepository),
                    container.get(ChatMessageRepository),
                    container.get(ChatPendingActionRepository),
                    container.get(ChatCatalog),
                    container.get(ProjectRepository),
                    { api: container.get(ApiChatEngine), cli: container.get(CliChatEngine) },
                    () => root.get(SettingsStore).get(CHAT_ENGINE),
                    () => requireSession(container.get(ServerKitContext)),
                );
            })
            .asTransient();
    },
};
