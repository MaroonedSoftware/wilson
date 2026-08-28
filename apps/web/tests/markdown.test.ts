import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '#src/lib/markdown.js';

describe('parseMarkdown', () => {
    it('keeps the structure inside a blockquote rather than flattening it', () => {
        const tree = parseMarkdown('> **Note.** First paragraph\n> wrapped onto two lines.\n>\n> - a listed point\n> - another');
        const [blockquote] = tree.children;
        expect(blockquote?.type).toBe('blockquote');
        if (blockquote?.type !== 'blockquote') throw new Error('expected a blockquote');
        expect(blockquote.children.map((child) => child.type)).toEqual(['paragraph', 'list']);
    });

    it('does not treat markdown syntax inside a fenced code block as structure', () => {
        const tree = parseMarkdown('```\n# not a heading\n- not a list\n```');
        const [code] = tree.children;
        expect(code).toMatchObject({ type: 'code', value: '# not a heading\n- not a list' });
    });
});
