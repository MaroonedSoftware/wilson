import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { ChatMessageRepository } from './chat.message.repository.js';
import { ChatPendingActionRepository } from './chat.pending.action.repository.js';
import { ChatThreadRepository } from './chat.thread.repository.js';

/**
 * The chat a person drives Wilson from, modelled on ats's web chat: an agent that reads through the
 * operation catalog (`McpModule`) and proposes changes for the person to confirm. So far this holds
 * only where a conversation is kept — threads, messages and pending actions
 * (`data/migrations/20261029120000_chat.sql`).
 */
export const ChatModule: ServerKitModule = {
    name: 'Chat',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(ChatThreadRepository).useClass(ChatThreadRepository).asTransient();
        registry.register(ChatMessageRepository).useClass(ChatMessageRepository).asTransient();
        registry.register(ChatPendingActionRepository).useClass(ChatPendingActionRepository).asTransient();
    },
};
