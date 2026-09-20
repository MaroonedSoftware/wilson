import { describe, expect, it } from 'vitest';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';

/**
 * Card 0264. `DAILY_OUTPUT_TOKEN_CEILING` is the `SettingDefinition` `Poller.tickProject` and
 * `BoardWriteService.start` both read to decide whether a project has spent its daily output-token
 * budget — the identity a database row is keyed by (`key`), the environment variable a fresh database
 * falls back to (`envVar`), the project scope a daily budget is (`scope`, the same reasoning
 * `RE_REVIEW_ON_MERGE`'s own test gives), and the value nothing has ever configured (`defaultValue`:
 * `0`, meaning no ceiling at all — the same shape `CARD_STAGE_CONCURRENCY`'s own test proves for a
 * definition whose default is a number rather than a boolean).
 */
describe('DAILY_OUTPUT_TOKEN_CEILING', () => {
    it('is keyed daily-output-token-ceiling, reads DAILY_OUTPUT_TOKEN_CEILING, defaults to 0 (no ceiling), and is project-scoped', () => {
        expect(DAILY_OUTPUT_TOKEN_CEILING.key).toBe('daily-output-token-ceiling');
        expect(DAILY_OUTPUT_TOKEN_CEILING.envVar).toBe('DAILY_OUTPUT_TOKEN_CEILING');
        expect(DAILY_OUTPUT_TOKEN_CEILING.defaultValue).toBe(0);
        expect(DAILY_OUTPUT_TOKEN_CEILING.scope).toBe('project');
    });

    it.each([
        ['0', 0],
        ['1', 1],
        ['10000', 10000],
        ['500000', 500000],
    ])('parses the raw env string %j as the integer %d', (raw, expected) => {
        expect(DAILY_OUTPUT_TOKEN_CEILING.parseEnv(raw)).toBe(expected);
    });

    /**
     * Fail-fast posture matching `CARD_STAGE_CONCURRENCY`: a typo'd, fractional, or negative env
     * value must not silently resolve to a plausible-but-wrong ceiling — a negative one especially,
     * since it is closer in spirit to "always over budget" than to "no ceiling", which only `0` means
     * here.
     */
    it.each([['not-a-number'], ['3.5'], ['NaN'], ['Infinity'], ['-1'], ['-10000']])(
        'throws rather than silently falling back when the environment value %j is not a non-negative integer',
        raw => {
            expect(() => DAILY_OUTPUT_TOKEN_CEILING.parseEnv(raw)).toThrow(`Invalid DAILY_OUTPUT_TOKEN_CEILING: "${raw}" is not a non-negative integer`);
        },
    );
});
