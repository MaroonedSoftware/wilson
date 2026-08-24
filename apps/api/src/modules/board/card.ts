/**
 * A card.
 *
 * The card file *is* the plan file (PROJECT.md, Board format): frontmatter carries the state the
 * runner owns, the body carries the plan contract under fixed headings. One file per card, so a
 * transition is a single atomic write and two cards moving at once cannot conflict.
 */

/** The plan contract headings, in the order they appear in a card file. */
export const PLAN_SECTIONS = ['Goal', 'Constraints', 'Files in scope', 'Tasks', 'Acceptance criteria', 'Out of scope'] as const;

export type PlanSection = (typeof PLAN_SECTIONS)[number];

/**
 * The closed enum a plan-review finding must anchor to. Kebab-cased section names — the machine
 * readable form of the same headings.
 */
export const PLAN_SECTION_KEYS = ['goal', 'constraints', 'files-in-scope', 'tasks', 'acceptance-criteria', 'out-of-scope'] as const;

export type PlanSectionKey = (typeof PLAN_SECTION_KEYS)[number];

export const sectionKey = (section: PlanSection): PlanSectionKey => section.toLowerCase().replace(/\s+/g, '-') as PlanSectionKey;

export interface CardFrontmatter {
    id: string;
    title: string;
    stage: string;
    branch?: string;
    /** Hard blocks. A card whose dependency is unfinished must not dispatch. */
    dependsOn: string[];
    /** Kickback counters, keyed by the stage that kicked back. */
    retries: Record<string, number>;
    /**
     * The card version approved at plan approval. Downstream stages read the card at this version,
     * not the newest one, so an edit made while a stage is running cannot retroactively change the
     * contract the running agent is working to.
     */
    planVersionId?: string;
    /** External source refs, e.g. `{ linear: 'ENG-123' }`. Durable here so it survives losing Postgres. */
    external?: Record<string, string>;
    /** Set by a card source when its ticket is closed upstream. Never moves the card by itself. */
    sourceClosed?: boolean;
    /** A person has to look at this card before it runs again. Never moves the card by itself. */
    needsHuman?: boolean;
    /** What the runner or the operator said when they set `needsHuman`. */
    needsHumanReason?: string;
}

export interface Card {
    frontmatter: CardFrontmatter;
    /** Section heading → the markdown beneath it, trimmed. */
    sections: Partial<Record<PlanSection, string>>;
    /** The raw body, preserved verbatim so a round-trip through the parser changes nothing. */
    body: string;
}

/**
 * Split a card body on the plan-contract headings.
 *
 * Only the known headings start a section; any other `##` is left inside whichever section it falls
 * in, so a plan is free to use sub-structure without confusing the parser. Body-only and pure, so
 * it belongs beside `filesInScope` rather than in the frontmatter parser — a card reconstructed
 * from a stored body needs it just as much as one read from a file.
 */
export const sectionsOf = (body: string): Partial<Record<PlanSection, string>> => {
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
 * The globs a stage may write to, read from the `Files in scope` section.
 *
 * Globs, not paths, so a plan does not have to predict every file it will create. Bullet markers,
 * inline code backticks and blank lines are all stripped; anything else on a line is taken as a
 * pattern.
 */
export const filesInScope = (card: Card): string[] => {
    const raw = card.sections['Files in scope'];
    if (!raw) return [];
    return raw
        .split('\n')
        .map(line =>
            line
                .replace(/^\s*[-*+]\s*/, '')
                .replace(/`/g, '')
                .trim(),
        )
        .filter(line => line.length > 0 && !line.startsWith('<!--'));
};
