import { describe, expect, it } from 'vitest';
import { parseCard, serializeCard, CardParseError } from '#modules/board/card.parser.js';
import { filesInScope } from '#modules/board/card.js';

const CARD = `---
id: '0042'
title: Port allocator
stage: implementing
branch: card/0042-port-allocator
dependsOn:
    - '0039'
retries:
    review: 1
planSha: 8f2c1ab
---

## Goal

Allocate a unique port per worktree.

## Files in scope

- \`src/runner/**\`
- src/config/ports.ts

## Out of scope

Anything to do with the queue.
`;

describe('parseCard', () => {
    it('reads the frontmatter', () => {
        const card = parseCard(CARD);
        expect(card.frontmatter).toMatchObject({
            id: '0042',
            title: 'Port allocator',
            stage: 'implementing',
            branch: 'card/0042-port-allocator',
            dependsOn: ['0039'],
            retries: { review: 1 },
            planSha: '8f2c1ab',
        });
    });

    it('splits the body on the plan-contract headings', () => {
        const card = parseCard(CARD);
        expect(card.sections['Goal']).toBe('Allocate a unique port per worktree.');
        expect(card.sections['Out of scope']).toBe('Anything to do with the queue.');
    });

    it('defaults the optional state fields rather than leaving them undefined', () => {
        const card = parseCard('---\nid: "1"\ntitle: t\nstage: planning\n---\n\n## Goal\n\nx\n');
        expect(card.frontmatter.dependsOn).toEqual([]);
        expect(card.frontmatter.retries).toEqual({});
    });

    it.each([
        ['no frontmatter', '## Goal\n\nx\n'],
        ['a missing stage', '---\nid: "1"\ntitle: t\n---\n\n## Goal\n'],
        ['a missing id', '---\ntitle: t\nstage: planning\n---\n'],
        ['frontmatter that is not a mapping', '---\n- a\n- b\n---\n'],
    ])('throws on %s rather than repairing it', (_label, raw) => {
        // A card the parser cannot read is a card the runner must not act on: a defaulted `stage`
        // dispatches the wrong work, a defaulted `dependsOn` dispatches blocked work.
        expect(() => parseCard(raw)).toThrow(CardParseError);
    });
});

describe('filesInScope', () => {
    it('strips bullets and backticks', () => {
        expect(filesInScope(parseCard(CARD))).toEqual(['src/runner/**', 'src/config/ports.ts']);
    });

    it('is empty when the section is absent', () => {
        expect(filesInScope(parseCard('---\nid: "1"\ntitle: t\nstage: planning\n---\n\n## Goal\n\nx\n'))).toEqual([]);
    });
});

describe('serializeCard', () => {
    it('round-trips without changing the body', () => {
        const card = parseCard(CARD);
        expect(parseCard(serializeCard(card)).body).toBe(card.body);
    });

    it('preserves prose verbatim when only state changes', () => {
        const card = parseCard(CARD);
        const moved = { ...card, frontmatter: { ...card.frontmatter, stage: 'testing' } };
        const reparsed = parseCard(serializeCard(moved));
        // A transition must not show up as a content diff — the body is written back, never
        // re-rendered from the parsed sections.
        expect(reparsed.body).toBe(card.body);
        expect(reparsed.frontmatter.stage).toBe('testing');
    });

    it('omits optional fields that are unset', () => {
        const card = parseCard('---\nid: "1"\ntitle: t\nstage: planning\n---\n\n## Goal\n\nx\n');
        expect(serializeCard(card)).not.toContain('planSha');
        expect(serializeCard(card)).not.toContain('branch');
    });
});
