import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { serializeCard } from '#modules/board/card.parser.js';
import { sectionsOf, type Card } from '#modules/board/card.js';

const BODY = `
## Goal

Allocate a unique port per worktree.

## Files in scope

- \`src/runner/**\`
- src/config/ports.ts

## Out of scope

Anything to do with the queue.
`;

const card = (frontmatter: Partial<Card['frontmatter']> = {}, body = BODY): Card => ({
    frontmatter: { id: '0042', title: 'Port allocator', stage: 'implementing', dependsOn: [], retries: {}, ...frontmatter },
    sections: sectionsOf(body),
    body,
});

/** Split a serialized card back into its frontmatter mapping and its body, for assertions. */
const split = (raw: string): { frontmatter: Record<string, unknown>; body: string } => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    if (!match) throw new Error('no frontmatter block');
    return { frontmatter: parseYaml(match[1]!) as Record<string, unknown>, body: raw.slice(match[0].length) };
};

/**
 * `serializeCard` is what the agent reads: `materializePlan` writes the pinned card this way for a
 * stage. Nothing parses the format back any more (the board is Postgres), so what matters is that
 * the frontmatter names the runner state a stage's agent is told about and the body is the human's
 * text untouched.
 */
describe('serializeCard', () => {
    it('writes the frontmatter as YAML and the body verbatim after it', () => {
        const serialized = serializeCard(
            card({ branch: 'card/0042-port-allocator', dependsOn: ['0039'], retries: { review: 1 }, planVersionId: '17' }),
        );

        const { frontmatter, body } = split(serialized);
        expect(frontmatter).toEqual({
            id: '0042',
            title: 'Port allocator',
            stage: 'implementing',
            branch: 'card/0042-port-allocator',
            dependsOn: ['0039'],
            retries: { review: 1 },
            planSha: '17',
        });
        expect(body).toBe(BODY);
    });

    it('preserves prose verbatim when only state changes', () => {
        const before = serializeCard(card());
        const after = serializeCard(card({ stage: 'testing' }));

        // A transition must not show up as a content diff — the body is written back, never
        // re-rendered from the parsed sections.
        expect(split(after).body).toBe(split(before).body);
        expect(split(after).frontmatter.stage).toBe('testing');
    });

    it('omits optional fields that are unset', () => {
        const serialized = serializeCard(card());

        expect(serialized).not.toContain('planSha');
        expect(serialized).not.toContain('branch');
        expect(serialized).not.toContain('needsHuman');
        expect(serialized).not.toContain('external');
        expect(serialized).not.toContain('sourceClosed');
    });

    it('writes needsHuman and its reason when the card carries them', () => {
        const { frontmatter } = split(serializeCard(card({ needsHuman: true, needsHumanReason: 'blocked on legal' })));

        expect(frontmatter.needsHuman).toBe(true);
        expect(frontmatter.needsHumanReason).toBe('blocked on legal');
    });

    it('writes external refs and sourceClosed when set, including an explicit false', () => {
        const { frontmatter } = split(serializeCard(card({ external: { linear: 'ENG-123' }, sourceClosed: false })));

        expect(frontmatter.external).toEqual({ linear: 'ENG-123' });
        expect(frontmatter.sourceClosed).toBe(false);
    });
});
