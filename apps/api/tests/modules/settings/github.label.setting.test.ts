import { describe, expect, it } from 'vitest';
import { GITHUB_LABEL } from '#modules/settings/github.label.setting.js';

/**
 * Card 0199. `GITHUB_LABEL` defaults to something a reader can recognise as "the label that means
 * import this" — never to the empty string, which would ask GitHub for every open issue in the repo.
 */
describe('GITHUB_LABEL', () => {
    it('is keyed github-label, scoped per project, reads GITHUB_LABEL, and defaults to wilson-import', () => {
        expect(GITHUB_LABEL.key).toBe('github-label');
        expect(GITHUB_LABEL.scope).toBe('project');
        expect(GITHUB_LABEL.envVar).toBe('GITHUB_LABEL');
        expect(GITHUB_LABEL.defaultValue).toBe('wilson-import');
    });

    it('parseEnv passes the raw string through unchanged', () => {
        expect(GITHUB_LABEL.parseEnv('needs-triage')).toBe('needs-triage');
    });
});
