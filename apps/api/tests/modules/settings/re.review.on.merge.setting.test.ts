import { describe, expect, it } from 'vitest';
import { RE_REVIEW_ON_MERGE } from '#modules/settings/re.review.on.merge.setting.js';

/**
 * Card 0238. `RE_REVIEW_ON_MERGE` is the `SettingDefinition` `merge` reads to decide whether to run
 * its re-review check at all — the identity a database row is keyed by (`key`), the environment
 * variable a fresh database falls back to (`envVar`), the value nothing has ever configured
 * (`defaultValue`), and the project scope the check's own Constraints call for. Parsed identically to
 * `DRY_RUN_ENABLED`/`POLLER_ENABLED`: only `"true"`/`"1"` (case- and whitespace-insensitively) count
 * as an explicit "on".
 */
describe('RE_REVIEW_ON_MERGE', () => {
    it('is keyed re-review-on-merge, reads RE_REVIEW_ON_MERGE, defaults to on, and is project-scoped', () => {
        expect(RE_REVIEW_ON_MERGE.key).toBe('re-review-on-merge');
        expect(RE_REVIEW_ON_MERGE.envVar).toBe('RE_REVIEW_ON_MERGE');
        expect(RE_REVIEW_ON_MERGE.defaultValue).toBe(true);
        expect(RE_REVIEW_ON_MERGE.scope).toBe('project');
    });

    it.each([
        ['true', true],
        ['1', true],
        ['TRUE', true],
        [' true ', true],
        ['false', false],
        ['0', false],
        ['yes', false],
        ['', false],
        ['unset-looking-garbage', false],
    ])('parses the raw env string %j as %s', (raw, expected) => {
        expect(RE_REVIEW_ON_MERGE.parseEnv(raw)).toBe(expected);
    });
});
