import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Parent, PhrasingContent, Root, Text } from 'mdast';

const CARD_REF = /\[\[(\d+)\]\]/g;

type Point = { line: number; column: number; offset?: number };
type Position = { start: Point; end: Point };

/** The position of `value.slice(start, end)`, relative to `base`'s own position — `base` is the
 * position of the text node `value` came from. Walks `value` up to each offset counting `\n`s, so
 * this stays correct even for a split that happens to straddle a line (a card ref never does, but
 * a wrapped paragraph line containing one does). */
function slicePosition(base: Position | undefined, value: string, start: number, end: number): Position | undefined {
    const startPoint = pointAt(base?.start, value, start);
    const endPoint = pointAt(base?.start, value, end);
    if (!startPoint || !endPoint) return undefined;
    return { start: startPoint, end: endPoint };
}

function pointAt(basePoint: Point | undefined, value: string, offset: number): Point | undefined {
    if (!basePoint) return undefined;
    let line = basePoint.line;
    let column = basePoint.column;
    for (let i = 0; i < offset; i++) {
        if (value[i] === '\n') {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    const point: Point = { line, column };
    if (basePoint.offset !== undefined) point.offset = basePoint.offset + offset;
    return point;
}

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
    const { value, position } = node;
    CARD_REF.lastIndex = 0;
    if (!CARD_REF.test(value)) return null;
    CARD_REF.lastIndex = 0;

    const parts: PhrasingContent[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = CARD_REF.exec(value))) {
        const full = match[0];
        const id = match[1]!;
        const matchStart = match.index;
        const matchEnd = matchStart + full.length;
        if (matchStart > last) {
            parts.push({ type: 'text', value: value.slice(last, matchStart), position: slicePosition(position, value, last, matchStart) });
        }
        const linkPosition = slicePosition(position, value, matchStart, matchEnd);
        parts.push({
            type: 'link',
            url: `/cards/${id}`,
            children: [{ type: 'text', value: full, position: linkPosition }],
            position: linkPosition,
        });
        last = matchEnd;
    }
    if (last < value.length) {
        parts.push({ type: 'text', value: value.slice(last), position: slicePosition(position, value, last, value.length) });
    }
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
