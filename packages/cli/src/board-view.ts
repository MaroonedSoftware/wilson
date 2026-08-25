import { DateTime, Duration } from 'luxon';
import type { CardEvent, CardSummary } from '@wilson/sdk';

/**
 * A handful of pure, read-only functions the CLI used to get from `@wilson/api/cli-bootstrap`.
 * Duplicated here, deliberately: the CLI no longer depends on `@wilson/api` (card 0078), and these
 * are small enough — and stable enough — that copying them is cheaper and less risky than inventing
 * an endpoint for each. If any of these drift from their board-side originals
 * (`apps/api/src/modules/board/next.card.ts`, `.../card.js`, `apps/api/src/modules/events/time.in.stage.ts`),
 * fix both sides; there is no single source left to import from.
 */

/**
 * The dependency ids named on `card` that are not yet satisfied, in the order they appear.
 *
 * Mirrors `unsatisfiedDependencies` in `apps/api/src/modules/board/next.card.ts`, adapted to
 * `CardSummary`'s flat shape (no `frontmatter` wrapper). A dependency is satisfied only once the
 * named card exists on the board and has reached `merged` — one missing from the board entirely
 * counts as unfinished, never as fine.
 */
export const unsatisfiedDependencies = (card: CardSummary, cards: CardSummary[]): string[] => {
    const byId = new Map(cards.map(c => [c.id, c]));
    const isFinished = (id: string): boolean => byId.get(id)?.stage === 'merged';
    return card.dependsOn.filter(id => !isFinished(id));
};

export interface Blocked {
    card: CardSummary;
    blockedBy: string[];
}

export interface NextCard {
    next?: CardSummary;
    blocked: Blocked[];
    flagged: CardSummary[];
}

/**
 * Pick the next card to work on. Mirrors `nextCard` in `apps/api/src/modules/board/next.card.ts`,
 * adapted to `CardSummary`. `nonStages` takes the place of the board's own `NON_STAGE_STATES` —
 * fetched from `GET /api/stages` (`BoardColumns.nonStages`) rather than hard-coded, so a stage added
 * to the board's config does not require a CLI release to match it.
 */
export const nextCard = (cards: CardSummary[], nonStages: string[]): NextCard => {
    const candidates: CardSummary[] = [];
    const blocked: Blocked[] = [];
    const flagged: CardSummary[] = [];

    for (const card of cards) {
        if (nonStages.includes(card.stage)) continue;

        if (card.needsHuman) {
            flagged.push(card);
            continue;
        }

        const blockedBy = unsatisfiedDependencies(card, cards);
        if (blockedBy.length === 0) {
            candidates.push(card);
        } else {
            blocked.push({ card, blockedBy });
        }
    }

    const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    candidates.sort(byId);
    blocked.sort((a, b) => byId(a.card, b.card));
    flagged.sort(byId);

    return { next: candidates[0], blocked, flagged };
};

/**
 * The globs a plan names under "Files in scope". Mirrors `filesInScope` in
 * `apps/api/src/modules/board/card.js`, operating on `CardDetail.sections` instead of a locally-read
 * `Card`.
 */
export const filesInScope = (sections: Record<string, string>): string[] => {
    const raw = sections['Files in scope'];
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

/**
 * How long a card has held its current stage, derived from its event log. Mirrors
 * `timeInCurrentStage` in `apps/api/src/modules/events/time.in.stage.ts`, parsing `CardEvent`'s wire
 * `createdAt` (an ISO string) into a `DateTime` instead of reading one off a database row.
 */
export const timeInCurrentStage = (events: CardEvent[], now: DateTime): Duration | undefined => {
    const [earliest] = events;
    if (!earliest) return undefined;

    const lastTransition = [...events].reverse().find(event => event.type === 'transition.written');
    const since = DateTime.fromISO((lastTransition ?? earliest).createdAt);

    return now.diff(since);
};

/**
 * Environment for a spawned `claude` process with the API's own provider key stripped, so an
 * interactive planning session authenticates with the operator's own `claude` subscription/login
 * rather than silently reusing the API's key. Mirrors `subscriptionEnv` in
 * `apps/api/src/modules/agent/cli.stage.agent.ts`.
 */
export const subscriptionEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
};
