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
    /** How the card ended, once it has. The repository keeps this in step with `stage` on every write. */
    doneReason?: string;
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
    /**
     * The card this one was split out of, set once by `BoardWriteService.split`. Like `position`,
     * not part of what `write`/`writeWithEvent` persist: a piece's origin never changes.
     */
    splitFrom?: string;
    /**
     * Orders the parking lot; absent for a card nothing has ever dragged, which sorts by `id`
     * instead (`PostgresBoardRepository.list`) and meaningless outside `parking-lot` (card 0091).
     *
     * Not part of what `write`/`writeWithEvent` persist, unlike every other field here: a reposition
     * must not mint a card version, so it goes through `BoardRepository.setPosition` instead, and a
     * mutate callback that changes this field through the ordinary write path silently has no effect
     * on the stored row.
     */
    position?: number;
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
const planHeading = (line: string): PlanSection | undefined => {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    return heading?.[1] ? PLAN_SECTIONS.find(s => s.toLowerCase() === heading[1]!.toLowerCase()) : undefined;
};

/**
 * The headings the runner appends to a body (`append.findings.ts`, `append.attempts.ts`). `sectionsOf`
 * reads them as part of the plan section they follow; anything that rewrites a section must not.
 */
const RUNNER_HEADINGS = ['## Review findings', '## Previous attempts'];

const endsSection = (line: string): boolean => planHeading(line) !== undefined || RUNNER_HEADINGS.includes(line.trim());

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
        const matched = planHeading(line);
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
 * Why `body` cannot be a card's plan, in words a refusal can use: a plan-contract section absent or
 * empty, or an empty "Files in scope". Undefined for a body that can be approved. Each of these would
 * otherwise kill the card at dispatch, stages after whoever approved it.
 */
export const planGap = (body: string): string | undefined => {
    const sections = sectionsOf(body);
    const missing = PLAN_SECTIONS.filter(section => !sections[section] || sections[section]!.trim().length === 0);
    if (missing.length > 0) return `draft is incomplete — empty section(s): ${missing.join(', ')}`;
    return filesInScope({ frontmatter: {} as CardFrontmatter, sections, body }).length === 0 ? 'draft has an empty "Files in scope"' : undefined;
};

/**
 * A section as `sectionsOf` read it, up to the first heading the runner appended: the text a person
 * wrote, and so the text `withSection` replaces and accepts back.
 */
export const authoredText = (section: string): string => {
    const lines = section.split('\n');
    const end = lines.findIndex(line => RUNNER_HEADINGS.includes(line.trim()));
    return end === -1 ? section : lines.slice(0, end).join('\n').trim();
};

/**
 * `body` with one section's text replaced and every other byte kept: the sections around it and the
 * runner's own appended sections after it. The last heading wins when a section repeats, as it does
 * in `sectionsOf`. Undefined for a plan without that section, or `text` that carries a heading of its
 * own, which would move the boundary of some other section.
 */
export const withSection = (body: string, section: PlanSection, text: string): string | undefined => {
    if (text.split('\n').some(endsSection)) return undefined;

    const lines = body.split('\n');
    const start = lines.reduce((found, line, index) => (planHeading(line) === section ? index : found), -1);
    if (start === -1) return undefined;

    const next = lines.findIndex((line, index) => index > start && endsSection(line));
    const after = next === -1 ? [] : ['', ...lines.slice(next)];
    return [...lines.slice(0, start + 1), '', text.trim(), ...after].join('\n') + (next === -1 ? '\n' : '');
};

/**
 * A card body completed with whichever of the six `PLAN_SECTIONS` headings it lacks, each
 * appended at the end as its own empty section, in `PLAN_SECTIONS` order. A body that already has
 * all six is returned unchanged, byte for byte; a heading the body does have keeps its own
 * position and wording — this only adds what is missing, it never reorders or rewrites what is
 * already there.
 *
 * Seeds a planning draft from a card's own prose — a `## Note` card promoted out of the parking
 * lot, say — instead of discarding it for a blank skeleton just because the plan-contract
 * headings are not there yet.
 */
export const completeSections = (body: string): string => {
    const sections = sectionsOf(body);
    const missing = PLAN_SECTIONS.filter(section => !(section in sections));
    if (missing.length === 0) return body;
    const skeleton = missing.map(section => `## ${section}\n`).join('\n');
    return `${body.trimEnd()}\n\n${skeleton}`;
};

/** A line's bullet marker (`-`, `*`, `+`, `1.` or `1)`), with any leading indentation and trailing spaces after it. */
const BULLET_MARKER = /^\s*(?:[-*+]|\d+[.)](?=\s))\s*/;

/**
 * Split a plan-contract section into its bullets.
 *
 * A line starting with a `-`, `*`, `+` or list-number marker begins a bullet — an indented marker still starts
 * its own bullet, so a nested list item is never folded into the one above it. A non-blank line
 * that follows without a marker of its own continues the bullet above it, joined with a single
 * space so a criterion wrapped across several lines reads as one sentence. A blank line ends the
 * current bullet: two bullets separated by a blank line never join.
 *
 * A section whose lines carry no bullet marker at all keeps today's one-item-per-line behaviour —
 * the shape `Files in scope` relies on for a bare list of paths.
 *
 * Bullet markers and inline code backticks are stripped, and HTML comment lines dropped, same as
 * every caller did before this split existed.
 */
const splitBullets = (raw: string): string[] => {
    const lines = raw.split('\n');
    const clean = (line: string) => line.replace(/`/g, '').trim();
    const hasMarkers = lines.some(line => line.trim().length > 0 && BULLET_MARKER.test(line));

    if (!hasMarkers) {
        return lines.map(clean).filter(line => line.length > 0 && !line.startsWith('<!--'));
    }

    const items: string[] = [];
    let current: string | undefined;

    for (const line of lines) {
        if (line.trim().length === 0) {
            if (current !== undefined) items.push(current);
            current = undefined;
            continue;
        }
        if (line.trim().startsWith('<!--')) continue;
        if (BULLET_MARKER.test(line)) {
            if (current !== undefined) items.push(current);
            current = clean(line.replace(BULLET_MARKER, ''));
        } else {
            const cleaned = clean(line);
            current = current === undefined ? cleaned : `${current} ${cleaned}`;
        }
    }
    if (current !== undefined) items.push(current);
    return items.filter(item => item.length > 0);
};

/**
 * The globs a stage may write to, read from the `Files in scope` section.
 *
 * Globs, not paths, so a plan does not have to predict every file it will create. Bullet markers,
 * inline code backticks and blank lines are all stripped; anything else on a line is taken as a
 * pattern. A bullet's text may wrap across lines: `splitBullets` folds the continuation onto it.
 */
export const filesInScope = (card: Card): string[] => {
    const raw = card.sections['Files in scope'];
    if (!raw) return [];
    return splitBullets(raw);
};

/** A leading `AC1:`, `AC-1:` or `AC1.` token on a bullet, normalized to `AC<n>`. */
const ACCEPTANCE_CRITERION_ID = /^AC-?(\d+)[:.]\s*(.*)$/;

/**
 * The plan's acceptance criteria, each with a stable ID and its text.
 *
 * ID rule: a leading `AC1:`, `AC-1:` or `AC1.` token on a bullet is its ID, normalized to `AC<n>`.
 * A bullet without one gets a positional `AC<n>` from its order among the section's bullets — so
 * every plan written before this card, none of which carry bullet IDs, still gets stable IDs
 * without being rewritten.
 *
 * Same bullet stripping as `filesInScope`: markers and inline code backticks are stripped, and
 * blank lines and HTML comments are dropped, before IDs are assigned.
 */
/** A `Expected skipped tests: N` bullet, matched case-insensitively, `N` captured as digits. */
const EXPECTED_SKIPPED_TESTS = /^Expected skipped tests:\s*(\d+)\b/i;

/**
 * The plan's declared ceiling on how much the skipped-test count may rise, from a `Constraints`
 * bullet naming it explicitly: `Expected skipped tests: N`, optionally followed by a reason in
 * parentheses. `N` must be a positive integer — no declaration, `0`, or anything that is not a
 * number is `undefined`, which callers treat as "no ceiling declared" rather than "ceiling of
 * zero". More than one declaration uses the first.
 *
 * Lets `checkCounts` (testing.verifier.ts) tell a plan's deliberately skipped suite, named as such
 * in its own Constraints, apart from an agent turning a red test yellow — the distinction card
 * 0232 added after it caught card 0231's deliberately skipped suite in the same net as the rule it
 * exists to enforce.
 */
export const expectedSkippedTests = (card: Card): number | undefined => {
    const raw = card.sections['Constraints'];
    if (!raw) return undefined;
    const bullets = splitBullets(raw);

    for (const bullet of bullets) {
        const match = EXPECTED_SKIPPED_TESTS.exec(bullet);
        if (!match) continue;
        const n = Number(match[1]);
        return n > 0 ? n : undefined;
    }
    return undefined;
};

export const acceptanceCriteria = (card: Card): { id: string; text: string }[] => {
    const raw = card.sections['Acceptance criteria'];
    if (!raw) return [];
    const bullets = splitBullets(raw);

    return bullets.map((bulletText, index) => {
        const match = ACCEPTANCE_CRITERION_ID.exec(bulletText);
        return match ? { id: `AC${match[1]}`, text: match[2]!.trim() } : { id: `AC${index + 1}`, text: bulletText };
    });
};
