import { describe, expect, it } from 'vitest';
import { ServerFeed } from '@maroonedsoftware/serverfeed';
import { planFeed } from '#modules/plan/plan.session.feed.js';

/**
 * Card 0132, task 3: `planFeed` is a `ServerFeed` for assistant deltas keyed by card, following
 * `card.feed.ts`'s module-level-singleton shape. Nothing in this codebase constructs a second one,
 * so what is worth pinning down here is exactly that: it is a real, usable `ServerFeed`, and every
 * importer shares the one instance rather than each getting its own.
 */
describe('planFeed', () => {
    it('is a real ServerFeed instance, not a stub', () => {
        expect(planFeed).toBeInstanceOf(ServerFeed);
    });

    it('is the same singleton across every import, the way a live session (held by one process only) needs it to be', async () => {
        const again = await import('#modules/plan/plan.session.feed.js');
        expect(again.planFeed).toBe(planFeed);
    });

    it('delivers a published delta to a subscriber keyed by project and card id, the scheme a live session publishes under', () => {
        const received: unknown[] = [];
        const unsubscribe = planFeed.onEvent({ source: 'proj-0132', correlationId: '0099' }, event => received.push(event));
        try {
            planFeed.status('proj-0132', '0099', 'assistant delta', { text: 'hello from the model' });

            expect(received).toHaveLength(1);
            expect(received[0]).toMatchObject({
                source: 'proj-0132',
                correlationId: '0099',
                message: 'assistant delta',
                data: { text: 'hello from the model' },
            });
        } finally {
            unsubscribe();
        }
    });

    it('does not deliver a delta published for a different card to a subscriber scoped to this one', () => {
        const received: unknown[] = [];
        const unsubscribe = planFeed.onEvent({ source: 'proj-0132', correlationId: '0099' }, event => received.push(event));
        try {
            planFeed.status('proj-0132', 'some-other-card', 'assistant delta', { text: 'not for this subscriber' });

            expect(received).toHaveLength(0);
        } finally {
            unsubscribe();
        }
    });
});
