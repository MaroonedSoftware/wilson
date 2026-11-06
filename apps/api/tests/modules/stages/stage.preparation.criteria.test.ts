import { describe, expect, it } from 'vitest';
import type { Card } from '#modules/board/card.js';
import type { ProjectStages, StageConfig } from '#modules/stages/stage.config.js';
import { planMaterial } from '#modules/stages/stage.preparation.js';

/**
 * Card 0016: a plan that numbers its acceptance criteria `1.`, `2.` gets positional `AC<n>` IDs it
 * never prints, so `plan.md` lists them for the agent to report against.
 */
describe('planMaterial acceptance criteria IDs', () => {
    const stage = { name: 'review', extraScope: [] } as unknown as StageConfig;
    const stages = { stages: [stage] } as unknown as ProjectStages;

    const card = (sections: Record<string, string>, body: string): Card => ({
        frontmatter: { id: '0001', title: 'thing', stage: 'review', dependsOn: [], retries: {} },
        sections,
        body,
    });

    it('lists each criterion under the ID the runner checks it by', () => {
        const criteria = '1. draws the image\n2. shows alt text for anything else';
        const plan = planMaterial(card({ 'Acceptance criteria': criteria }, `## Acceptance criteria\n\n${criteria}`), stages, stage);

        expect(plan).toContain('## Acceptance criteria IDs');
        expect(plan).toContain('- `AC1`: draws the image');
        expect(plan).toContain('- `AC2`: shows alt text for anything else');
    });

    it('cuts a long criterion to a preview', () => {
        const long = `1. ${'x'.repeat(200)}`;
        const plan = planMaterial(card({ 'Acceptance criteria': long }, `## Acceptance criteria\n\n${long}`), stages, stage);

        const line = plan.split('\n').find(l => l.startsWith('- `AC1`:'));
        expect(line).toBeDefined();
        expect(line!.length).toBeLessThan(100);
        expect(line!.endsWith('…')).toBe(true);
    });

    it('adds nothing for a plan with no acceptance criteria', () => {
        const plan = planMaterial(card({}, '## Goal\n\nDo the thing.'), stages, stage);

        expect(plan).not.toContain('Acceptance criteria IDs');
    });
});
