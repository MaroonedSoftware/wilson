import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ChatCatalog } from './chat.catalog.js';
import { ChatMessageRepository } from './chat.message.repository.js';
import { ChatPendingActionRepository } from './chat.pending.action.repository.js';
import { ChatThreadRepository } from './chat.thread.repository.js';

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
    },
};
