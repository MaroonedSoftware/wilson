import { describe, expect, it } from 'vitest';
import { CONTEXT_OVERFLOW_REASON, isContextOverflow, isPermanentFailure } from '#modules/stages/permanent.failure.js';

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

/**
 * Card 0072. `isContextOverflow` carves a narrower case out of `PERMANENT`'s
 * `/invalid[_ ]request[_ ]error/i` — matched *only* when the provider's own "prompt is too long"
 * wording is present alongside that error class, so it claims nothing `isPermanentFailure` would not
 * already have poisoned, and leaves every other malformed request exactly where it was.
 */
describe('isContextOverflow', () => {
    it.each([
        [
            '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 220000 tokens > 200000 maximum"}}',
            'the provider\'s own overflow shape',
        ],
        ['Claude Code process failed: invalid_request_error - prompt is too long', 'a differently-worded overflow'],
        ['INVALID_REQUEST_ERROR: Prompt Is Too Long', 'mixed case'],
    ])('recognises %s as a context overflow (%s)', message => {
        expect(isContextOverflow(new Error(message))).toBe(true);
    });

    it.each([
        ['{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}', 'an unrelated malformed request'],
        ['prompt is too long, please shorten your message', "wording alone, without the provider's error class"],
        ['Your credit balance is too low to access the Anthropic API.', 'an unrelated permanent failure'],
        ['socket hang up', 'an ordinary transient failure'],
    ])('does not treat %s as a context overflow (%s)', message => {
        expect(isContextOverflow(new Error(message))).toBe(false);
    });

    it('reads the cause as well as the message, the same as isPermanentFailure', () => {
        const wrapped = new Error('Claude Code process failed', {
            cause: new Error('invalid_request_error: prompt is too long'),
        });
        expect(isContextOverflow(wrapped)).toBe(true);
    });

    it('handles a non-Error throw without blowing up', () => {
        expect(isContextOverflow('invalid_request_error: prompt is too long')).toBe(true);
        expect(isContextOverflow(undefined)).toBe(false);
    });

    /**
     * Pins the premise `classifyDispatchFailure`'s ordering fix depends on: a context overflow's
     * message still matches `PERMANENT`'s broad `invalid_request_error` pattern, so without checking
     * `isContextOverflow` first, `isPermanentFailure` alone would poison it.
     */
    it('is also caught by the broader isPermanentFailure pattern, which is why the ordering matters', () => {
        const message = 'invalid_request_error: prompt is too long: 220000 tokens > 200000 maximum';
        expect(isPermanentFailure(new Error(message))).toBe(true);
        expect(isContextOverflow(new Error(message))).toBe(true);
    });

    it('names the context window, not the request, in the reason an operator sees', () => {
        expect(CONTEXT_OVERFLOW_REASON).toMatch(/context/i);
        expect(CONTEXT_OVERFLOW_REASON).toMatch(/window/i);
        expect(CONTEXT_OVERFLOW_REASON).not.toMatch(/invalid_request_error/i);
    });
});
