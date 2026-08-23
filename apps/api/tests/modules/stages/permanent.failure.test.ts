import { describe, expect, it } from 'vitest';
import { isPermanentFailure } from '#modules/stages/permanent.failure.js';

/**
 * The classifier that decides whether the queue retries.
 *
 * Written against errors this project actually hit. A card burned three retry cycles against
 * "credit balance is too low", each one dispatching a stage, cutting a worktree and installing
 * dependencies before failing at the first model call.
 */
describe('isPermanentFailure', () => {
    it.each([
        ['Your credit balance is too low to access the Anthropic API.', 'exhausted balance'],
        ['Claude Code returned an error result: Not logged in · Please run /login', 'missing credentials'],
        ['{"type":"error","error":{"type":"invalid_request_error","message":"..."}}', 'malformed request'],
        ['authentication_error: invalid x-api-key', 'bad key'],
        ['Request failed with status 401', 'unauthorised'],
        ['Request failed with status 403', 'forbidden'],
    ])('treats %s as permanent (%s)', message => {
        expect(isPermanentFailure(new Error(message))).toBe(true);
    });

    it.each([
        ['ETIMEDOUT connecting to api.anthropic.com', 'a timeout'],
        ['socket hang up', 'a dropped connection'],
        ['Request failed with status 529 overloaded_error', 'an overloaded provider'],
        ['Request failed with status 500', 'a server error'],
        ['build command failed (exit 1)', 'an ordinary stage failure'],
    ])('treats %s as transient (%s), so the queue may retry', message => {
        expect(isPermanentFailure(new Error(message))).toBe(false);
    });

    it('reads the cause as well as the message, since the SDK wraps its errors', () => {
        const wrapped = new Error('Claude Code process failed', { cause: new Error('credit balance is too low') });
        expect(isPermanentFailure(wrapped)).toBe(true);
    });

    it('handles a non-Error throw without blowing up', () => {
        expect(isPermanentFailure('not logged in')).toBe(true);
        expect(isPermanentFailure(undefined)).toBe(false);
    });
});
