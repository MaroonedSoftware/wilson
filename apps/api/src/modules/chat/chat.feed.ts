import { ServerFeed } from '@maroonedsoftware/serverfeed';
import type { ChatToolEvent } from './chat.tools.js';
import { toWireAction } from './chat.wire.js';

/** The `source` every chat event is published under; `correlationId` is the thread's id. */
export const CHAT_SOURCE = 'chat';

/**
 * What a turn in progress sends a person watching its thread, in order: the answer's text as it is
 * written (`delta`), each read as it runs (`operation`), each change as it is proposed (`proposed`),
 * then `done` once the answer is stored or `failed` with the reason it could not be.
 */
export type ChatStreamEvent =
    | { event: 'delta'; data: string }
    | { event: 'operation'; data: unknown }
    | { event: 'proposed'; data: unknown }
    | { event: 'done'; data: { seq: number } }
    | { event: 'failed'; data: { reason: string } };

/**
 * Live chat turns, keyed by thread (`ServerFeed`'s `${source}:${correlationId}`, under
 * {@link CHAT_SOURCE}). A plain module-level singleton, for the reason `plan.session.feed.ts` gives:
 * `ServerFeed` is meant to be held as a value, and a turn runs only in the process that is answering
 * it, so nothing needs bridging across processes.
 *
 * Ephemeral, like ats's `ChatStreamBroker`: the stored messages are the record, and a person who
 * connects mid-turn reads the thread for what came before and this for what is still arriving.
 */
export const chatFeed = new ServerFeed();

/** Publish one chat stream event for `threadId`. */
export const publishChat = (threadId: string, streamEvent: ChatStreamEvent): void => {
    chatFeed.status(CHAT_SOURCE, threadId, streamEvent.event, { payload: streamEvent.data });
};

/** A chat tool's event, as the stream sends it. */
export const toStreamEvent = (event: ChatToolEvent): ChatStreamEvent =>
    event.type === 'operation' ? { event: 'operation', data: event.operation } : { event: 'proposed', data: toWireAction(event.action) };

/** Subscribe to `threadId`'s stream events. Returns an unsubscribe function. */
export const onChatEvent = (threadId: string, listener: (streamEvent: ChatStreamEvent) => void): (() => void) =>
    chatFeed.onEvent({ source: CHAT_SOURCE, correlationId: threadId }, event =>
        listener({ event: event.message, data: event.data?.payload } as ChatStreamEvent),
    );
