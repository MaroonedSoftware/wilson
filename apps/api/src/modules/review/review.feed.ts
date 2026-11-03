import { ServerFeed } from '@maroonedsoftware/serverfeed';

/**
 * What a review's turn in progress sends a person watching: the answer's text as it is written
 * (`delta`), the tour whenever the agent writes one (`tour`), then `done` once it is stored or `failed` with the reason it could not be.
 */
export type ReviewStreamEvent =
    | { event: 'delta'; data: string }
    | { event: 'tour'; data: unknown }
    | { event: 'done'; data: { seq: number } }
    | { event: 'failed'; data: { reason: string } };

/**
 * Live review turns, keyed by card under its project, since two projects' cards can share an id. A
 * plain module-level singleton and ephemeral, for the reasons `chat.feed.ts` gives: the stored turns are
 * the record, and a person who connects mid-turn reads those and listens here for what is still arriving.
 */
export const reviewFeed = new ServerFeed();

/** Publish one stream event for a card's review. */
export const publishReview = (project: string, cardId: string, streamEvent: ReviewStreamEvent): void => {
    reviewFeed.status(project, cardId, streamEvent.event, { payload: streamEvent.data });
};

/** Subscribe to a card's review stream events. Returns an unsubscribe function. */
export const onReviewEvent = (project: string, cardId: string, listener: (streamEvent: ReviewStreamEvent) => void): (() => void) =>
    reviewFeed.onEvent({ source: project, correlationId: cardId }, event =>
        listener({ event: event.message, data: event.data?.payload } as ReviewStreamEvent),
    );
