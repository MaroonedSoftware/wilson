// @vitest-environment jsdom
//
// Card 0123 replaces the hand-rolled line parser in `lib/markdown.ts` with a remark/mdast parser,
// and `Markdown.tsx` now builds React elements from the mdast tree instead of the old
// `MarkdownBlock[]` shape. The thirteen behaviours the old `parseMarkdown` test file covered are not
// negotiable (see the card's Constraints) even though the shape they were asserted against is gone;
// this file re-covers all thirteen against the new tree, plus this card's own acceptance criteria —
// nested lists, `[[nnnn]]` card references, and reachable node positions.
//
// A few of the thirteen are about how the tree *renders*, not its shape — a wrapped paragraph's
// lines are joined with a literal `\n` in the mdast text node, and only read as space-separated once
// laid out as HTML (`white-space: normal` collapses it, and so does React Testing Library's default
// text matcher). Those live in the `Markdown` describe block below, rendered through a minimal
// router so the component's own `Link` (used for card references) has somewhere to resolve to.
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Blockquote, List, Paragraph, PhrasingContent, RootContent } from 'mdast';
import { parseMarkdown } from '#src/lib/markdown.js';
import { Markdown } from '#src/components/Markdown.js';

/** Concatenates the literal text of a run of phrasing content, so a block's rendered words can be
 * asserted on without depending on exactly how many text/strong/emphasis nodes it split into. */
function text(nodes: PhrasingContent[]): string {
    return nodes
        .map(node => {
            if (node.type === 'text' || node.type === 'inlineCode') return node.value;
            if ('children' in node) return text(node.children);
            return '';
        })
        .join('');
}

function asParagraph(node: RootContent | undefined): Paragraph {
    if (node?.type !== 'paragraph') throw new Error(`expected a paragraph, got ${node?.type}`);
    return node;
}

function asList(node: RootContent | undefined): List {
    if (node?.type !== 'list') throw new Error(`expected a list, got ${node?.type}`);
    return node;
}

function asBlockquote(node: RootContent | undefined): Blockquote {
    if (node?.type !== 'blockquote') throw new Error(`expected a blockquote, got ${node?.type}`);
    return node;
}

describe('parseMarkdown', () => {
    it("takes a heading's level from the number of hashes", () => {
        const tree = parseMarkdown('## Goal');
        const [heading] = tree.children;
        expect(heading?.type).toBe('heading');
        if (heading?.type !== 'heading') throw new Error('expected a heading');
        expect(heading.depth).toBe(2);
        expect(text(heading.children)).toBe('Goal');
    });

    it('treats a blank line as a paragraph break', () => {
        const tree = parseMarkdown('First paragraph.\n\nSecond paragraph.');
        expect(tree.children.map(node => node.type)).toEqual(['paragraph', 'paragraph']);
        expect(text(asParagraph(tree.children[0]).children)).toBe('First paragraph.');
        expect(text(asParagraph(tree.children[1]).children)).toBe('Second paragraph.');
    });

    it('folds a wrapped continuation line onto the bullet item it continues', () => {
        const list = asList(parseMarkdown('- first item\n- second item\n  still the second item').children[0]);
        expect(list.ordered).toBe(false);
        expect(list.children).toHaveLength(2);
        const [first, second] = list.children;
        expect(text(asParagraph(first?.children[0]).children)).toBe('first item');
        // Folded onto the same list item as a soft line break, not a second item.
        expect(text(asParagraph(second?.children[0]).children).replace(/\s+/g, ' ')).toBe('second item still the second item');
    });

    it('parses a numbered list as ordered', () => {
        const list = asList(parseMarkdown('1. one\n2. two\n3. three').children[0]);
        expect(list.ordered).toBe(true);
        expect(list.children.map(item => text(asParagraph(item.children[0]).children))).toEqual(['one', 'two', 'three']);
    });

    it("keeps a fenced code block's language and body verbatim", () => {
        const tree = parseMarkdown('```ts\nconst x = 1;\nconst y = 2;\n```');
        expect(tree.children[0]).toMatchObject({ type: 'code', lang: 'ts', value: 'const x = 1;\nconst y = 2;' });
    });

    it('gives a fenced code block with no language none, rather than an empty one', () => {
        const [code] = parseMarkdown('```\nplain\n```').children;
        expect(code?.type).toBe('code');
        if (code?.type !== 'code') throw new Error('expected code');
        expect(code.lang == null).toBe(true);
        expect(code.lang).not.toBe('');
        expect(code.value).toBe('plain');
    });

    it('does not treat markdown syntax inside a fenced code block as structure', () => {
        const tree = parseMarkdown('```\n# not a heading\n- not a list\n```');
        expect(tree.children[0]).toMatchObject({ type: 'code', value: '# not a heading\n- not a list' });
    });

    it('parses a full plan-shaped document into the right sequence of blocks', () => {
        const body = [
            '## Goal',
            '',
            'Ship the detail view.',
            '',
            '## Tasks',
            '',
            '- one',
            '- two',
            '',
            '## Files in scope',
            '',
            '- `apps/web/**`',
        ].join('\n');
        const tree = parseMarkdown(body);
        expect(tree.children.map(node => node.type)).toEqual(['heading', 'paragraph', 'heading', 'list', 'heading', 'list']);
    });

    it('parses a quote as its own block', () => {
        const tree = parseMarkdown('> quoted text');
        expect(tree.children).toHaveLength(1);
        expect(tree.children[0]?.type).toBe('blockquote');
    });

    it('keeps the structure inside a blockquote rather than flattening it', () => {
        const blockquote = asBlockquote(
            parseMarkdown('> **Note.** First paragraph\n> wrapped onto two lines.\n>\n> - a listed point\n> - another').children[0],
        );
        expect(blockquote.children.map(child => child.type)).toEqual(['paragraph', 'list']);
        const paragraph = asParagraph(blockquote.children[0]);
        const list = asList(blockquote.children[1]);
        expect(paragraph.children.some(node => node.type === 'strong')).toBe(true);
        expect(text(paragraph.children).replace(/\s+/g, ' ')).toBe('Note. First paragraph wrapped onto two lines.');
        expect(list.children.map(item => text(asParagraph(item.children[0]).children))).toEqual(['a listed point', 'another']);
    });

    it('ends a quote at the first unquoted line', () => {
        const tree = parseMarkdown('> quoted\n\nnot quoted');
        expect(tree.children.map(node => node.type)).toEqual(['blockquote', 'paragraph']);
        const blockquote = asBlockquote(tree.children[0]);
        expect(text(asParagraph(blockquote.children[0]).children)).toBe('quoted');
        expect(text(asParagraph(tree.children[1]).children)).toBe('not quoted');
    });

    it('does not swallow a following paragraph into a preceding quote', () => {
        const tree = parseMarkdown('a paragraph\n> a quote');
        expect(tree.children.map(node => node.type)).toEqual(['paragraph', 'blockquote']);
        expect(text(asParagraph(tree.children[0]).children)).toBe('a paragraph');
    });

    it('keeps a nested bullet as a nested list rather than flattening it into its parent', () => {
        const list = asList(parseMarkdown('- top\n  - nested\n- top2').children[0]);
        expect(list.children).toHaveLength(2);
        const [topItem, secondItem] = list.children;
        expect(topItem?.children.map(child => child.type)).toEqual(['paragraph', 'list']);
        const nested = asList(topItem?.children[1]);
        expect(nested.children.map(item => text(asParagraph(item.children[0]).children))).toEqual(['nested']);
        expect(text(asParagraph(secondItem?.children[0]).children)).toBe('top2');
    });

    it('rewrites a [[nnnn]] card reference into a link to that card, leaving the surrounding text intact', () => {
        const paragraph = asParagraph(parseMarkdown('See [[0122]] for details.').children[0]);
        const link = paragraph.children.find(node => node.type === 'link');
        expect(link).toBeDefined();
        if (link?.type !== 'link') throw new Error('expected a link');
        expect(link.url).toBe('/cards/0122');
        expect(text(link.children)).toBe('[[0122]]');
        expect(text(paragraph.children)).toBe('See [[0122]] for details.');
    });

    it('leaves something that merely resembles a card reference alone inside a fenced code block', () => {
        const tree = parseMarkdown('```\nSee [[0122]] for details.\n```');
        expect(tree.children[0]).toMatchObject({ type: 'code', value: 'See [[0122]] for details.' });
    });

    it('keeps node positions reachable from the parsed tree, without re-parsing', () => {
        const tree = parseMarkdown('## Goal\n\nSecond paragraph.');
        const [heading, paragraph] = tree.children;
        expect(heading?.position?.start).toEqual({ line: 1, column: 1, offset: 0 });
        expect(paragraph?.position?.start.line).toBe(3);
    });

    it('derives a position for the text and link nodes a [[nnnn]] card reference is split into', () => {
        // Regression coverage for review finding markdown.ts:49 — splitCardRefs used to leave
        // `position` undefined on the nodes it produces, silently dropping source position for
        // exactly the syntax this card added, even though the parser otherwise keeps it on every node.
        const raw = 'See [[0122]] for details.';
        const matchStart = raw.indexOf('[[0122]]');
        const matchEnd = matchStart + '[[0122]]'.length;
        const paragraph = asParagraph(parseMarkdown(raw).children[0]);
        const [before, link, after] = paragraph.children;
        expect(before?.position).toBeDefined();
        expect(link?.position).toBeDefined();
        expect(after?.position).toBeDefined();
        expect(link?.position?.start).toEqual({ line: 1, column: matchStart + 1, offset: matchStart });
        expect(link?.position?.end).toEqual({ line: 1, column: matchEnd + 1, offset: matchEnd });
        // The three nodes tile the original text exactly, with no gap or overlap between them.
        expect(before?.position?.end).toEqual(link?.position?.start);
        expect(link?.position?.end).toEqual(after?.position?.start);
    });

    it('derives a position on a multi-line paragraph for a card reference past the first line', () => {
        // Same regression, but for a reference on a wrapped continuation line — slicePosition must
        // count the newline it walks past rather than assuming the match is on the node's start line.
        const tree = parseMarkdown('See\n[[0122]] for details.');
        const paragraph = asParagraph(tree.children[0]);
        const link = paragraph.children.find(node => node.type === 'link');
        expect(link?.type).toBe('link');
        if (link?.type !== 'link') throw new Error('expected a link');
        expect(link.position?.start.line).toBe(2);
        expect(link.position?.start.column).toBe(1);
    });
});

describe('Markdown', () => {
    beforeEach(() => {
        // jsdom does not implement matchMedia; MantineProvider reads it (colour-scheme detection) on
        // mount regardless of what this test renders. Same stand-in other component tests use.
        vi.stubGlobal(
            'matchMedia',
            vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    let body = '';
    const rootRoute = createRootRoute();
    const homeRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => createElement(Markdown, { body }),
    });
    // `[[nnnn]]` resolves through the same `/cards/$cardId` route `CardDetail`'s own links use;
    // it never needs to render anything for these tests to see where the link points.
    const cardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/cards/$cardId', component: () => null });
    const routeTree = rootRoute.addChildren([homeRoute, cardRoute]);

    function renderMarkdown(markdownBody: string) {
        body = markdownBody;
        const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) });
        return render(createElement(MantineProvider, null, createElement(RouterProvider, { router })));
    }

    it('joins wrapped paragraph lines into one visual block, separated by spaces', async () => {
        renderMarkdown('This is a plan\nthat wraps across\nseveral lines.');
        // The mdast text node keeps a literal `\n` between the wrapped lines (see the parseMarkdown
        // tests above) — this only reads as space-joined once laid out, which is what this render
        // assertion (and RTL's whitespace-normalizing text matcher) actually exercises.
        const found = await screen.findByText('This is a plan that wraps across several lines.');
        expect(found.tagName).toBe('P');
    });

    it('renders a nested bullet list nested, not flattened to one level', async () => {
        const { container } = renderMarkdown('- top\n  - nested\n- top2');
        await screen.findByText('top2');
        const outerList = container.querySelector('ul');
        if (!outerList) throw new Error('expected a rendered list');
        const topLevelItems = Array.from(outerList.children).filter(child => child.tagName === 'LI');
        expect(topLevelItems).toHaveLength(2);
        const nestedList = outerList.querySelector('ul');
        expect(nestedList).not.toBeNull();
        expect(nestedList?.textContent).toContain('nested');
        // The nested item is not one of the outer list's own two <li>s.
        expect(topLevelItems.some(item => item.querySelector('ul'))).toBe(true);
    });

    it('renders [[0122]] as a link to card 0122', async () => {
        renderMarkdown('See [[0122]] for details.');
        const link = await screen.findByText('[[0122]]');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('/cards/0122');
    });

    it('leaves text that merely resembles [[0122]] as literal text inside a fenced code block', async () => {
        const { container } = renderMarkdown('```\nSee [[0122]] for details.\n```');
        await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
        expect(container.querySelector('a')).toBeNull();
        expect(container.querySelector('pre')?.textContent).toBe('See [[0122]] for details.');
    });

    it('keeps the structure inside a rendered blockquote rather than flattening it', async () => {
        const { container } = renderMarkdown('> **Note.** First paragraph\n> wrapped onto two lines.\n>\n> - a listed point\n> - another');
        const note = await screen.findByText('Note.');
        expect(note.tagName).toBe('SPAN');
        const list = container.querySelector('ul');
        expect(list?.textContent).toContain('a listed point');
        expect(list?.textContent).toContain('another');
    });

    it('degrades a block-level node type the renderer has no case for to its literal source text, rather than dropping it', async () => {
        // Regression coverage for review finding Markdown.tsx:71 — a thematic break ('---' on its own
        // line) is a first-class mdast node under the CommonMark parser this card adopted, but
        // renderBlock's switch has no case for it. The old hand-rolled renderer always fell back to
        // literal paragraph text for a line it didn't recognise; this asserts the new renderer still
        // shows *something* for it rather than silently vanishing.
        renderMarkdown('before\n\n---\n\nafter');
        await screen.findByText('before');
        await screen.findByText('after');
        expect(await screen.findByText('---')).toBeDefined();
    });
});
