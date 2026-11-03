import type { Provider } from '#modules/agent/model.registry.js';
import type { AttachmentImageType } from '#modules/context/attachment.bytes.js';
import type { ChatMessage } from './chat.message.repository.js';
import type { ChatThread } from './chat.thread.repository.js';
import type { ChatTool } from './chat.tools.js';

/** An image a person sent, as a model is given it. */
export interface ChatImage {
    contentType: AttachmentImageType;
    bytes: Buffer;
}

/**
 * A message before this turn. `images` are the bytes to replay, which `ChatService` loads only for
 * recent messages on the engine that replays; `imageCount` says how many the message carried, so an
 * engine can say where the rest were rather than losing that they existed.
 */
export type ChatTurnHistory = Pick<ChatMessage, 'role' | 'content' | 'engineMessages'> & {
    imageCount?: number;
    images?: ChatImage[];
};

export interface ChatTurnInput {
    thread: Pick<ChatThread, 'id' | 'engineSessionId'>;
    /** The thread's messages before this turn, oldest first. The 'api' engine replays them; 'cli' resumes its session instead. */
    history: ChatTurnHistory[];
    /** What the person just said. Empty when they sent only images. */
    text: string;
    /** What the person just sent with it. */
    images?: ChatImage[];
    system: string;
    tools: ChatTool[];
    /** The `chat-engine` setting's provider and model. 'cli' runs Claude whatever the provider says. */
    provider: Provider;
    model: string;
    /** How many model steps the turn may take, `MAX_CHAT_STEPS` when left out. */
    maxSteps?: number;
    /**
     * Fail the turn if the engine offers or attempts any tool but `tools`. For a caller whose safety rests
     * on what the agent is able to do ('cli': nothing but `tools` is passed, and this checks it held).
     */
    onlyOwnTools?: boolean;
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
    /** What the turn cost, when the engine reports it ('cli'). */
    usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens: number };
}

/**
 * One turn of a chat, on one engine — the seam `StageAgent` is for stages, with `ApiChatEngine` (the
 * AI SDK) and `CliChatEngine` (the Claude Agent SDK) behind it. The tools, the prompt and what is
 * stored are the same either way (`ChatService`); an engine only runs the model and its tool loop.
 */
export abstract class ChatEngine {
    abstract turn(input: ChatTurnInput): Promise<ChatTurnOutput>;
}
