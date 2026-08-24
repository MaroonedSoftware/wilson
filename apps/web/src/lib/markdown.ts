export type MarkdownBlock =
    | { type: 'heading'; level: number; text: string }
    | { type: 'paragraph'; text: string }
    | { type: 'list'; ordered: boolean; items: string[] }
    | { type: 'code'; lang?: string; text: string };

const FENCE = /^```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET = /^\s*[-*+]\s+(.+)$/;
const NUMBERED = /^\s*\d+\.\s+(.+)$/;

/**
 * A line-based markdown parser scoped to what a plan body actually uses: headings, paragraphs,
 * bullet and numbered lists (including line-wrapped continuation lines), and fenced code blocks.
 *
 * Not a CommonMark implementation — the plan contract (PROJECT.md, Board format) is prose written
 * by a human or a planning agent, not markdown that exercises tables, nested lists or footnotes.
 * Rendering that plainer subset correctly beats pulling in a general parser for constructs the
 * contract never produces.
 */
export const parseMarkdown = (body: string): MarkdownBlock[] => {
    const lines = body.split('\n');
    const blocks: MarkdownBlock[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;

        if (line.trim().length === 0) {
            i++;
            continue;
        }

        const fence = FENCE.exec(line);
        if (fence) {
            const lang = fence[1] || undefined;
            const codeLines: string[] = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
                codeLines.push(lines[i]!);
                i++;
            }
            i++; // skip the closing fence, if any
            blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading) {
            blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
            i++;
            continue;
        }

        if (BULLET.test(line) || NUMBERED.test(line)) {
            const ordered = NUMBERED.test(line);
            const marker = ordered ? NUMBERED : BULLET;
            const items: string[] = [];
            while (i < lines.length) {
                const current = lines[i]!;
                if (current.trim().length === 0) break;
                const itemStart = marker.exec(current);
                if (itemStart) {
                    items.push(itemStart[1]!.trim());
                } else if (items.length > 0) {
                    // A wrapped continuation line, folded onto the item it continues.
                    items[items.length - 1] += ` ${current.trim()}`;
                } else {
                    break;
                }
                i++;
            }
            blocks.push({ type: 'list', ordered, items });
            continue;
        }

        const paragraphLines: string[] = [];
        while (i < lines.length && lines[i]!.trim().length > 0 && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBERED.test(lines[i]!)) {
            paragraphLines.push(lines[i]!.trim());
            i++;
        }
        blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
    }

    return blocks;
};
