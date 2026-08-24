import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '#src/lib/markdown.js';

describe('parseMarkdown', () => {
    it('parses a heading with its level from the number of hashes', () => {
        expect(parseMarkdown('## Goal')).toEqual([{ type: 'heading', level: 2, text: 'Goal' }]);
    });

    it('joins wrapped paragraph lines into a single block with spaces', () => {
        expect(parseMarkdown('This is a plan\nthat wraps across\nseveral lines.')).toEqual([
            { type: 'paragraph', text: 'This is a plan that wraps across several lines.' },
        ]);
    });

    it('treats a blank line as a paragraph break', () => {
        expect(parseMarkdown('First paragraph.\n\nSecond paragraph.')).toEqual([
            { type: 'paragraph', text: 'First paragraph.' },
            { type: 'paragraph', text: 'Second paragraph.' },
        ]);
    });

    it('parses a bullet list, folding wrapped continuation lines onto the item they continue', () => {
        expect(parseMarkdown('- first item\n- second item\n  still the second item')).toEqual([
            { type: 'list', ordered: false, items: ['first item', 'second item still the second item'] },
        ]);
    });

    it('parses a numbered list as ordered', () => {
        expect(parseMarkdown('1. one\n2. two\n3. three')).toEqual([
            { type: 'list', ordered: true, items: ['one', 'two', 'three'] },
        ]);
    });

    it('parses a fenced code block, keeping its language and body verbatim', () => {
        expect(parseMarkdown('```ts\nconst x = 1;\nconst y = 2;\n```')).toEqual([
            { type: 'code', lang: 'ts', text: 'const x = 1;\nconst y = 2;' },
        ]);
    });

    it('parses a fenced code block with no language as undefined', () => {
        expect(parseMarkdown('```\nplain\n```')).toEqual([{ type: 'code', lang: undefined, text: 'plain' }]);
    });

    it('does not treat markdown syntax inside a fenced code block as structure', () => {
        expect(parseMarkdown('```\n# not a heading\n- not a list\n```')).toEqual([
            { type: 'code', lang: undefined, text: '# not a heading\n- not a list' },
        ]);
    });

    it('parses a full plan-shaped document into the right sequence of blocks', () => {
        const body = ['## Goal', '', 'Ship the detail view.', '', '## Tasks', '', '- one', '- two', '', '## Files in scope', '', '- `apps/web/**`'].join(
            '\n',
        );
        expect(parseMarkdown(body)).toEqual([
            { type: 'heading', level: 2, text: 'Goal' },
            { type: 'paragraph', text: 'Ship the detail view.' },
            { type: 'heading', level: 2, text: 'Tasks' },
            { type: 'list', ordered: false, items: ['one', 'two'] },
            { type: 'heading', level: 2, text: 'Files in scope' },
            { type: 'list', ordered: false, items: ['`apps/web/**`'] },
        ]);
    });
});

describe('blockquotes', () => {
    it('parses a quote as its own block', () => {
        expect(parseMarkdown('> quoted text')).toEqual([{ type: 'quote', blocks: [{ type: 'paragraph', text: 'quoted text' }] }]);
    });

    it('keeps the structure inside a quote rather than flattening it', () => {
        const [block] = parseMarkdown('> **Note.** First paragraph\n> wrapped onto two lines.\n>\n> - a listed point\n> - another');
        expect(block).toEqual({
            type: 'quote',
            blocks: [
                { type: 'paragraph', text: '**Note.** First paragraph wrapped onto two lines.' },
                { type: 'list', ordered: false, items: ['a listed point', 'another'] },
            ],
        });
    });

    it('ends the quote at the first unquoted line', () => {
        expect(parseMarkdown('> quoted\n\nnot quoted')).toEqual([
            { type: 'quote', blocks: [{ type: 'paragraph', text: 'quoted' }] },
            { type: 'paragraph', text: 'not quoted' },
        ]);
    });

    it('does not swallow a following paragraph into a preceding one', () => {
        expect(parseMarkdown('a paragraph\n> a quote')).toEqual([
            { type: 'paragraph', text: 'a paragraph' },
            { type: 'quote', blocks: [{ type: 'paragraph', text: 'a quote' }] },
        ]);
    });
});
