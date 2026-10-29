import { describe, expect, it } from 'vitest';
import { onChatEvent, publishChat, type ChatStreamEvent } from '#modules/chat/chat.feed.js';

describe('the chat feed', () => {
    it("delivers a thread's events, in order, to whoever listens to that thread", () => {
        const heard: ChatStreamEvent[] = [];
        const stop = onChatEvent('feed-1', event => heard.push(event));

        publishChat('feed-1', { event: 'delta', data: 'One ' });
        publishChat('feed-1', { event: 'delta', data: 'card.' });
        publishChat('feed-1', { event: 'done', data: { seq: 2 } });
        stop();

        expect(heard).toEqual([
            { event: 'delta', data: 'One ' },
            { event: 'delta', data: 'card.' },
            { event: 'done', data: { seq: 2 } },
        ]);
    });

    it("never delivers another thread's events", () => {
        const heard: ChatStreamEvent[] = [];
        const stop = onChatEvent('feed-2', event => heard.push(event));

        publishChat('feed-3', { event: 'delta', data: 'elsewhere' });
        stop();

        expect(heard).toEqual([]);
    });

    it('stops delivering once unsubscribed', () => {
        const heard: ChatStreamEvent[] = [];
        onChatEvent('feed-4', event => heard.push(event))();

        publishChat('feed-4', { event: 'delta', data: 'too late' });

        expect(heard).toEqual([]);
    });
});
