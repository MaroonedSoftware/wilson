import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PLAN_SECTIONS, type Card, type CardFrontmatter, type PlanSection } from './card.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class CardParseError extends Error {}

/**
 * Parse a card file.
 *
 * Throws rather than repairing. A card the parser cannot read is a card the runner must not act on:
 * silently defaulting a missing `stage` would dispatch the wrong work, and silently defaulting
 * `dependsOn` would dispatch work that should have been blocked.
 */
export const parseCard = (raw: string): Card => {
    const match = FRONTMATTER.exec(raw);
    if (!match?.[1]) {
        throw new CardParseError('card file has no YAML frontmatter block');
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(match[1]);
    } catch (err) {
        throw new CardParseError(`card frontmatter is not valid YAML: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new CardParseError('card frontmatter must be a YAML mapping');
    }

    const fm = parsed as Record<string, unknown>;
    for (const key of ['id', 'title', 'stage'] as const) {
        if (typeof fm[key] !== 'string' || (fm[key] as string).length === 0) {
            throw new CardParseError(`card frontmatter is missing required string field: ${key}`);
        }
    }

    const frontmatter: CardFrontmatter = {
        id: fm.id as string,
        title: fm.title as string,
        stage: fm.stage as string,
        branch: typeof fm.branch === 'string' ? fm.branch : undefined,
        dependsOn: Array.isArray(fm.dependsOn) ? fm.dependsOn.map(String) : [],
        retries: isRecordOfNumbers(fm.retries) ? fm.retries : {},
        planSha: typeof fm.planSha === 'string' ? fm.planSha : undefined,
        external: isRecordOfStrings(fm.external) ? fm.external : undefined,
        sourceClosed: typeof fm.sourceClosed === 'boolean' ? fm.sourceClosed : undefined,
    };

    const body = raw.slice(match[0].length);
    return { frontmatter, sections: parseSections(body), body };
};

/**
 * Split the body on the plan-contract headings.
 *
 * Only the known headings start a section; any other `##` is left inside whichever section it falls
 * in, so a plan is free to use sub-structure without confusing the parser.
 */
const parseSections = (body: string): Partial<Record<PlanSection, string>> => {
    const sections: Partial<Record<PlanSection, string>> = {};
    const lines = body.split('\n');
    let current: PlanSection | undefined;
    let buffer: string[] = [];

    const flush = () => {
        if (current) sections[current] = buffer.join('\n').trim();
        buffer = [];
    };

    for (const line of lines) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        const matched = heading?.[1] ? PLAN_SECTIONS.find(s => s.toLowerCase() === heading[1]!.toLowerCase()) : undefined;
        if (matched) {
            flush();
            current = matched;
            continue;
        }
        if (current) buffer.push(line);
    }
    flush();
    return sections;
};

/**
 * Serialize a card back to a file.
 *
 * The body is written back verbatim, never re-rendered from `sections`. A transition changes
 * frontmatter only, and rewriting prose the human (or the planning agent) wrote — reflowing it,
 * normalising its lists — would make every state change show up as a content diff.
 */
export const serializeCard = (card: Card): string => {
    const fm: Record<string, unknown> = {
        id: card.frontmatter.id,
        title: card.frontmatter.title,
        stage: card.frontmatter.stage,
    };
    if (card.frontmatter.branch) fm.branch = card.frontmatter.branch;
    fm.dependsOn = card.frontmatter.dependsOn;
    fm.retries = card.frontmatter.retries;
    if (card.frontmatter.planSha) fm.planSha = card.frontmatter.planSha;
    if (card.frontmatter.external) fm.external = card.frontmatter.external;
    if (card.frontmatter.sourceClosed !== undefined) fm.sourceClosed = card.frontmatter.sourceClosed;

    return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${card.body}`;
};

const isRecordOfNumbers = (value: unknown): value is Record<string, number> =>
    typeof value === 'object' && value !== null && Object.values(value).every(v => typeof v === 'number');

const isRecordOfStrings = (value: unknown): value is Record<string, string> =>
    typeof value === 'object' && value !== null && Object.values(value).every(v => typeof v === 'string');
