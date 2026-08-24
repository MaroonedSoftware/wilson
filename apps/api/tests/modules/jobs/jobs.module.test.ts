import { describe, expect, it } from 'vitest';
import { CARD_STAGE_POLICY } from '#modules/jobs/jobs.module.js';

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
});
