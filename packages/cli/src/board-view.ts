import { DateTime, Duration } from 'luxon';
import type { CardEvent, CardSummary } from '@wilson/sdk';

/**
 * A handful of pure, read-only functions the CLI used to get from `@wilson/api/cli-bootstrap`.
 * Duplicated here, deliberately: the commands that use these no longer depend on `@wilson/api`
 * (card 0078 ports them to `@wilson/sdk`), and these are small enough — and stable enough — that
 * copying them is cheaper and less risky than inventing an endpoint for each. If any of these drift
 * from their board-side originals (`apps/api/src/modules/board/next.card.ts`, `.../card.js`,
 * `apps/api/src/modules/events/time.in.stage.ts`), fix both sides; there is no single source left to
 * import from.
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

/**
 * Stages a dependency can sit in that guarantee it will never reach `merged` — `dropped` and
 * `poisoned` today. Derived from `nonStages` (`BoardColumns.nonStages`, fetched from
 * `GET /api/stages`) rather than hard-coded, so a terminal state added to the board's config does
 * not require a CLI release to match it. `nonStages` also carries `parking-lot`, which is not
 * terminal — a card there can still move on — so it is excluded alongside `merged`.
 */
export const deadStages = (nonStages: string[]): string[] =>
    nonStages.filter(stage => stage !== 'merged' && stage !== 'parking-lot');

/**
 * The dependency ids named on `card` whose card has settled into a stage it can never leave —
 * `dropped` or `poisoned` today — and so can never become `merged`. Distinct from
 * `unsatisfiedDependencies`: a dependency still in progress is unsatisfied but not dead, and this
 * card does not change what "satisfied" means. Used to tell an operator "this will never clear"
 * apart from "this just isn't done yet".
 */
export const deadDependencies = (card: CardSummary, cards: CardSummary[], nonStages: string[]): string[] => {
    const dead = new Set(deadStages(nonStages));
    const byId = new Map(cards.map(c => [c.id, c]));
    return card.dependsOn.filter(id => {
        const dep = byId.get(id);
        return dep !== undefined && dead.has(dep.stage);
    });
};

/**
 * Render a dependency id for `blocked on ...` listings: bare (`0085`) when it may still merge,
 * annotated with its stage (`0085 (dropped — will never merge)`) when `deadDependencies` says it
 * cannot. Shared by `list.command.ts` and `next.command.ts` so the two printers read the same way.
 */
export const describeDependency = (id: string, cards: CardSummary[], dead: string[]): string =>
    dead.includes(id) ? `${id} (${cards.find(c => c.id === id)?.stage} — will never merge)` : id;

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
 * Which of `cards` have a `daemon.stale` event among the events the caller already fetched for them
 * (`eventsByCard`, keyed by card id) — card 0100's answer to "the runner is behind" not being
 * something a person has to already suspect to find, the same bar `nextCard`'s `flagged` bucket
 * clears for `needsHuman`.
 *
 * Deliberately not folded into `nextCard` itself: that function is pure over `CardSummary[]`, cheap
 * to call with nothing but the two board-list responses `next.command.ts` already fetches, and card
 * 0100 only ever recorded `daemon.stale` as an *event* (`CardStageJob.checkDaemonCurrent`, apps/api)
 * rather than a field on the card — reading it needs each card's event tail, a call per card the
 * caller controls the cost of by choosing which cards to ask for, not something this helper should
 * force on every `nextCard` caller.
 *
 * A card missing from `eventsByCard` (the caller chose not to fetch it) is simply not reported, the
 * same as one with events but no `daemon.stale` among them — absence of information here is not
 * itself a signal.
 */
export const staleDaemonCards = (cards: CardSummary[], eventsByCard: Map<string, CardEvent[]>): CardSummary[] => {
    const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return cards.filter(card => (eventsByCard.get(card.id) ?? []).some(event => event.type === 'daemon.stale')).sort(byId);
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
