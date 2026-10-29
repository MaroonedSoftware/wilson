import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { Logger } from '@maroonedsoftware/logger';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { ApiChatEngine } from './api.chat.engine.js';
import { ChatCatalog } from './chat.catalog.js';
import { ChatMessageRepository } from './chat.message.repository.js';
import { ChatPendingActionRepository } from './chat.pending.action.repository.js';
import { ChatService, type ChatEngineChoice } from './chat.service.js';
import { ChatThreadRepository } from './chat.thread.repository.js';

/** The engine and model every thread uses, until a setting chooses them. */
export const DEFAULT_CHAT_ENGINE: ChatEngineChoice = { engine: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5' };

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
                        { api: container.get(ApiChatEngine), cli: undefined },
                        async () => DEFAULT_CHAT_ENGINE,
                    ),
            )
            .asTransient();
    },
};
