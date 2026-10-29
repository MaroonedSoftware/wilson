import type { Provider } from '#modules/agent/model.registry.js';
import type { ChatMessage } from './chat.message.repository.js';
import type { ChatThread } from './chat.thread.repository.js';
import type { ChatTool } from './chat.tools.js';

export interface ChatTurnInput {
    thread: ChatThread;
    /** The thread's messages before this turn, oldest first. The 'api' engine replays them; 'cli' resumes its session instead. */
    history: ChatMessage[];
    /** What the person just said. */
    text: string;
    system: string;
    tools: ChatTool[];
    /** The `chat-engine` setting's provider and model. 'cli' runs Claude whatever the provider says. */
    provider: Provider;
    model: string;
    /** Called with each piece of the answer as it is written. */
    onText?: (delta: string) => void;
}

export interface ChatTurnOutput {
    /** The whole answer. */
    text: string;
    /** The engine's own record of the turn, stored on the answer and handed back in `history` next time ('api'). */
    engineMessages?: unknown;
    /** The session to resume next turn ('cli'). */
    engineSessionId?: string;
}

/**
 * One turn of a chat, on one engine — the seam `StageAgent` is for stages, with `ApiChatEngine` (the
 * AI SDK) and `CliChatEngine` (the Claude Agent SDK) behind it. The tools, the prompt and what is
 * stored are the same either way (`ChatService`); an engine only runs the model and its tool loop.
 */
export abstract class ChatEngine {
    abstract turn(input: ChatTurnInput): Promise<ChatTurnOutput>;
}
