import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Parent, PhrasingContent, Root, Text } from 'mdast';

const CARD_REF = /\[\[(\d+)\]\]/g;

/**
 * `[[nnnn]]` cites another card by id (see PROJECT.md — "a parked card is a durable reference").
 * Rewrites matching text nodes into links to that card's route, in place, across the whole tree.
 *
 * Runs as a tree transform after parsing rather than as a fifth inline regex in the renderer:
 * `[[nnnn]]` is bespoke syntax no stock parser knows, and text nodes are the parser's own
 * extension point for exactly this. It only ever visits `text` nodes, so it never reaches into a
 * `code`/`inlineCode` node's raw `value` — text that merely resembles a reference inside a fenced
 * code block stays literal.
 */
function remarkCardRefs() {
    return (tree: Root) => {
        visitAndSplit(tree);
    };
}

function visitAndSplit(node: Root | Parent): void {
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]!;
        if (child.type === 'text') {
            const replacement = splitCardRefs(child);
            if (replacement) children.splice(i, 1, ...replacement);
        } else if ('children' in child) {
            visitAndSplit(child);
        }
    }
}

function splitCardRefs(node: Text): PhrasingContent[] | null {
    const { value } = node;
    CARD_REF.lastIndex = 0;
    if (!CARD_REF.test(value)) return null;
    CARD_REF.lastIndex = 0;

    const parts: PhrasingContent[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = CARD_REF.exec(value))) {
        const full = match[0];
        const id = match[1]!;
        if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) });
        parts.push({ type: 'link', url: `/cards/${id}`, children: [{ type: 'text', value: full }] });
        last = match.index + full.length;
    }
    if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
    return parts;
}

const processor = unified().use(remarkParse).use(remarkCardRefs);

/**
 * Parses a card body into an mdast tree, positions intact on every node.
 *
 * Not a hand-rolled parser: card bodies are prose written by a human or a planning agent, and a
 * general parser with a supported plugin story handles that — including constructs no card on this
 * board happens to produce yet — better than another line regex would. `remarkCardRefs` above is
 * that plugin story's first user.
 */
export function parseMarkdown(body: string): Root {
    const tree = processor.parse(body);
    return processor.runSync(tree, body) as Root;
}
