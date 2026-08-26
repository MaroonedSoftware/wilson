import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerFeed } from '@maroonedsoftware/serverfeed';
import type { SseContext, SseResponse } from '@maroonedsoftware/koa';
import { openCardFeedStream } from '#modules/feed/card.feed.route.js';

/**
 * A fake SSE socket: `openSseStream` is documented as unit-testable against a fake `ctx.res`
 * sink without standing up a real server, so this drives the real transport and the real
 * `ServerFeed` — only the raw socket is faked.
 */
const fakeCtx = (): { ctx: SseContext; frames: () => string[]; ended: () => boolean } => {
    const chunks: string[] = [];
    let ended = false;
    const res: SseResponse = {
        writeHead: () => undefined,
        write: (chunk: string) => {
            chunks.push(chunk);
            return true;
        },
        end: () => {
            ended = true;
        },
        destroy: () => undefined,
        setTimeout: () => undefined,
        on: () => undefined,
    };
    return { ctx: { status: 0, respond: true, res }, frames: () => [...chunks], ended: () => ended };
};

/** Pulls the JSON `data:` payload out of every `event: card` frame written so far. */
const cardEvents = (frames: string[]): Array<Record<string, unknown>> =>
    frames
        .filter(frame => frame.startsWith('event: card\n'))
        .map(frame => {
            const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
            if (!dataLine) throw new Error(`frame carried no data line: ${frame}`);
            return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
        });

describe('openCardFeedStream', () => {
    // `openSseStream` starts a 15s heartbeat interval on every call; fake timers keep it from
    // becoming a real, leaking timer across test runs.
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * The requirement the plan calls out by name: a client connecting mid-run gets current state
     * immediately, not a replay it has to fold. Two updates to the same card must collapse to the
     * one the subscriber actually needs.
     */
    it('hands a newly connected subscriber only the latest event per card, not every update that led to it', () => {
        const feed = new ServerFeed();
        feed.status('proj', '0001', 'stage.dispatched', { stage: 'implementing' });
        feed.status('proj', '0001', 'transition.written', { stage: 'testing' });

        const { ctx, frames } = fakeCtx();
        openCardFeedStream(ctx, feed);

        const events = cardEvents(frames());
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            source: 'proj',
            correlationId: '0001',
            message: 'transition.written',
            data: { stage: 'testing' },
        });
    });

    it('hands a newly connected subscriber the latest state of every distinct card, not just one', () => {
        const feed = new ServerFeed();
        feed.status('proj', '0001', 'stage.dispatched', { stage: 'implementing' });
        feed.status('proj', '0002', 'stage.dispatched', { stage: 'review' });

        const { ctx, frames } = fakeCtx();
        openCardFeedStream(ctx, feed);

        const ids = cardEvents(frames())
            .map(event => event.correlationId)
            .sort();
        expect(ids).toEqual(['0001', '0002']);
    });

    /**
     * A subscriber that connects to an otherwise-quiet feed still gets told about anything that
     * happens next — the snapshot on connect is a supplement to live delivery, not a substitute.
     */
    it('forwards a live event published after connecting, on top of the initial snapshot', () => {
        const feed = new ServerFeed();
        feed.status('proj', '0001', 'stage.dispatched', { stage: 'implementing' });

        const { ctx, frames } = fakeCtx();
        openCardFeedStream(ctx, feed);
        expect(cardEvents(frames())).toHaveLength(1);

        feed.status('proj', '0002', 'transition.written', { stage: 'parking-lot' });

        const events = cardEvents(frames());
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({ correlationId: '0002', data: { stage: 'parking-lot' } });
    });

    it('sends nothing on connect when the feed has published nothing yet', () => {
        const feed = new ServerFeed();

        const { ctx, frames } = fakeCtx();
        openCardFeedStream(ctx, feed);

        expect(cardEvents(frames())).toHaveLength(0);
    });

    /**
     * Card 0042: without a signal an SSE stream never ends on its own, so a shutdown had to wait
     * out the force-close grace period for every connected client. `signal` is how shutdown drains
     * a stream instead — this is the observable effect of that plumbing, exercised through the
     * real transport (`openSseStream`), not a mock of it.
     */
    it('ends the underlying response when the given signal aborts, instead of waiting to be force-closed', () => {
        const feed = new ServerFeed();
        const controller = new AbortController();
        const { ctx, ended } = fakeCtx();

        openCardFeedStream(ctx, feed, controller.signal);
        expect(ended()).toBe(false);

        controller.abort();

        expect(ended()).toBe(true);
    });

    /**
     * The open question this card was parked on: aborting the signal has to unwind
     * `feed.onEvent`'s subscription too, not just close the transport, or a shutdown stream would
     * keep the feed holding a reference to a dead subscriber forever.
     */
    it('releases the feed subscription when the given signal aborts, on shutdown as on client disconnect', () => {
        const feed = new ServerFeed();
        feed.status('proj', '0001', 'stage.dispatched', { stage: 'implementing' });
        const controller = new AbortController();
        const { ctx, frames } = fakeCtx();

        openCardFeedStream(ctx, feed, controller.signal);
        expect(cardEvents(frames())).toHaveLength(1);

        controller.abort();
        feed.status('proj', '0002', 'stage.dispatched', { stage: 'review' });

        // A live subscriber would have picked up the second card's event too; a closed stream must
        // not, or the abort didn't actually release the subscription.
        expect(cardEvents(frames())).toHaveLength(1);
    });

    it('leaves the stream open with no end-of-life effect when no signal is given at all', () => {
        const feed = new ServerFeed();
        const { ctx, ended } = fakeCtx();

        openCardFeedStream(ctx, feed);

        expect(ended()).toBe(false);
    });
});
