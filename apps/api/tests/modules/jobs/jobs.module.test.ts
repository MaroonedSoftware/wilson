import { describe, expect, it } from 'vitest';
import { CARD_STAGE_DEAD_POLICY, CARD_STAGE_POLICY } from '#modules/jobs/jobs.module.js';

/**
 * Card 0044: `retryLimit` moved from 2 to 3. pg-boss's own expiry sweep and its shutdown-while-active
 * redelivery both consume the same `retry_count < retry_limit` budget as an ordinary thrown failure
 * (see the comment on `CARD_STAGE_POLICY`), so one slot has to exist as headroom for that before a
 * stage's own logic gets to run again — on top of, not instead of, the retries a genuine transient
 * failure gets.
 */
describe('CARD_STAGE_POLICY', () => {
    it('allows 3 retries, one more than a transient-failure budget alone, as headroom for an expiry or shutdown-while-active redelivery', () => {
        expect(CARD_STAGE_POLICY.retryLimit).toBe(3);
    });

    it('names card.stage.dead as the queue a card.stage job that exhausts this policy lands in', () => {
        expect(CARD_STAGE_POLICY.deadLetter).toBe('card.stage.dead');
    });
});

/**
 * Card 0051: `card.stage.dead` finally has a subscriber (`CardStageDeadJob`), and that handler must
 * not be able to dead-letter itself — a failure inside it should log and stop, not spend a retry
 * budget or recurse into a second, equally-unread dead-letter queue.
 */
describe('CARD_STAGE_DEAD_POLICY', () => {
    it('retries a failing card.stage.dead job zero times', () => {
        expect(CARD_STAGE_DEAD_POLICY.retryLimit).toBe(0);
    });

    it('gives card.stage.dead no dead letter of its own', () => {
        expect(CARD_STAGE_DEAD_POLICY.deadLetter).toBeUndefined();
    });
});
