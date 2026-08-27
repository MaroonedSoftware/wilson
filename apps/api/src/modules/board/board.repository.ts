import { Injectable } from 'injectkit';
import type { DateTime } from 'luxon';
import type { AppendableCardEvent, EventLog } from '#modules/events/event.log.js';
import { findStage, type ProjectStages } from '#modules/stages/stage.config.js';
import { isTerminal } from '#modules/stages/terminal.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { filesInScope, type Card } from './card.js';
import { scopeOverlap, type OverlappingPatterns } from './scope.overlap.js';

/** One row of a card's version history — what `git log` on the board repo used to answer. */
export interface CardVersionSummary {
    id: string;
    message: string;
    createdAt: DateTime;
}

/**
 * Cap on how much of a card's event history {@link scopeConflict} scans for `scope.granted` rows.
 *
 * `EventLog.tail` only ever returns the most recent `limit` rows (event.log.ts), and there is no
 * type-filtered query to fall back to — `event.log.ts` is outside this card's (0104) "Files in
 * scope". Generous rather than exact: a card whose event history runs past this before a grant would
 * still miss it, but that is the same shape of best-effort every other caller of `tail` already
 * accepts, not a new kind of gap.
 */
const GRANTED_PATHS_LOOKBACK = 2000;

/**
 * Every path granted to `cardId` via `request_scope`, across whatever of its history {@link
 * GRANTED_PATHS_LOOKBACK} reaches — the `scope.granted` events card 0069's `ScopeGuard` records.
 */
const grantedPaths = async (events: EventLog, project: string, cardId: string): Promise<string[]> => {
    const rows = await events.tail(project, cardId, GRANTED_PATHS_LOOKBACK);
    return rows.filter(row => row.type === 'scope.granted').map(row => String((row.payload as { path?: unknown }).path));
};

/**
 * A card's effective scope for a scope-overlap comparison: its plan's declared "Files in scope"
 * patterns, plus every path granted to it via `request_scope` and not already covered by a declared
 * pattern.
 *
 * Declared scope alone misses exactly the case that motivated this (card 0104, the 0090/0100
 * incident): two cards colliding entirely through paths neither plan named, acquired mid-run instead.
 */
export const effectiveScope = (card: Card, granted: readonly string[]): string[] => {
    const declared = filesInScope(card);
    const extra = granted.filter(path => !declared.includes(path));
    return [...declared, ...extra];
};

/**
 * Whether `card` currently sits in a stage the runner ever dispatches a job into — an agent-mode
 * stage. `ready`/`backlog`-shaped stages, `parking-lot`, and every terminal stage hold nothing (card
 * 0104), so a card there can be skipped without a database round trip. Mirrors the stage
 * classification `whyNotDispatchable` (jobs/dispatchable.ts) applies to the card being dispatched,
 * applied here to every *other* card on the board — deliberately not `needsHuman`-aware, unlike
 * `whyNotDispatchable`: a card flagged mid-`implementing` still has an unmerged worktree holding
 * those files, so it still counts.
 *
 * Card 0128: no longer the decisive signal by itself — only ever a cheap first filter ahead of
 * {@link BoardRepository.hasLiveClaim}, the real question. A card sitting here holds nothing unless
 * something is actually carrying it: the gridlock this card fixed was exactly a parked card (deferred,
 * or its chain stopped) sitting in an agent stage with no job, being treated as if it did.
 */
const isRunningStage = (card: Card, stages: ProjectStages): boolean => {
    const stageName = card.frontmatter.stage;
    if (isTerminal(stageName) || stageName === 'parking-lot') return false;
    try {
        return findStage(stages, stageName).mode === 'agent';
    } catch {
        return false;
    }
};

/**
 * The board.
 *
 * An abstract class rather than an interface so it can be a DI token, and a seam even though one
 * implementation exists (PROJECT.md, "seams, even with one implementation"). Knows nothing about the
 * CLI: a library the CLI drives and the API drives, which is what kept step 6 from being a rewrite.
 *
 * Every mutation goes through `write` or `create`, which snapshot the card into an append-only
 * version and return that version's id. The runner is the sole writer of card state (decision 5).
 */
@Injectable()
export abstract class BoardRepository {
    abstract list(): Promise<Card[]>;

    abstract read(id: string): Promise<Card>;

    /**
     * Read a card as it stood at a specific version.
     *
     * This is how a running stage sees its plan: pinned to `planVersion`, so an edit landing while
     * the stage runs cannot change the contract underneath it. A version snapshots frontmatter and
     * body together, because the dispatcher reads both from the pinned card.
     */
    abstract readAt(id: string, version: string): Promise<Card>;

    /** The most recent version of this card, or undefined if it has none. */
    abstract currentVersion(id: string): Promise<string | undefined>;

    /** This card's version history, newest first, capped at `limit` rows. */
    abstract versions(id: string, limit: number): Promise<CardVersionSummary[]>;

    /**
     * Apply a change to one card and record it.
     *
     * Read-modify-write: the mutate callback receives the card as it is right now, not a copy the
     * caller read earlier and may have been holding while something else wrote. Returns the new
     * version id.
     */
    abstract write(id: string, message: string, mutate: (card: Card) => Card | Promise<Card>): Promise<string>;

    /**
     * Write a transition and the event describing it as one operation.
     *
     * This is the reason the board is in Postgres. Previously a transition committed the card file
     * to git and then appended the event here — two stores, sequentially, with no way to reconcile a
     * partial failure. Exposing the pair as a single method rather than a transaction handle the
     * caller must remember to pass makes the invariant structural instead of conventional.
     *
     * Returns the new version's id, like `write` — a caller that needs to point something at the
     * version this write just created (card 0129: advancing a pin past the findings a write just
     * folded in) has no other way to learn it, since `currentVersion` read from inside `mutate`
     * still answers with the version *before* this one — the off-by-one `board.write.service.ts:136`
     * explains and `BoardWriteService.approve` relies on deliberately.
     */
    abstract writeWithEvent(id: string, message: string, mutate: (card: Card) => Card | Promise<Card>, event: AppendableCardEvent): Promise<string>;

    /** Create a card that does not exist yet. Fails if the id is taken. */
    abstract create(card: Card, message: string): Promise<string>;

    /**
     * Reclaim a card's worktree once a transition has landed it on a terminal stage, and record that
     * it happened.
     *
     * The one place "the card is done" turns into "the worktree goes away" — shared by the runner's
     * own terminal transitions (`StageDispatcher.writeTransition`) and a human's `wilson card move`,
     * so the two callers cannot drift into two definitions of done. `isTerminal(target)` is the
     * runner's own rule; a human override inherits it rather than growing its own idea of "finished".
     *
     * `worktrees` and `events` are passed in rather than injected here: this class has no worktree or
     * event-log dependency of its own, and taking them as parameters lets a caller that already holds
     * both (the dispatcher's constructor fields, or a CLI command's DI container) share this one
     * decision without this abstract class growing dependencies neither its contract nor its Postgres
     * implementation otherwise needs.
     *
     * Never reclaims a flagged card's tree — `args.flagged` must reflect the card's state *before*
     * this transition, even when the transition itself is what clears the flag. Card 0055 keeps a
     * flagged card's worktree on purpose, so a person has something to inspect; that guarantee must
     * hold no matter which caller is the one reaching a terminal state. Do not "fix" this to check the
     * post-transition flag — a card moved straight to a terminal state by the person who is right now
     * looking at the flag is still a card whose tree that flag promised would survive.
     *
     * Best-effort, like the transition it follows: a failure to remove a directory is reported back
     * rather than thrown, so a `writeWithEvent` that already committed is never unwound by a cleanup
     * step failing after the fact. The caller decides how to log it.
     */
    async reclaimIfTerminal(
        worktrees: WorktreeManager,
        events: EventLog,
        args: { project: string; cardId: string; stage: string; target: string; flagged: boolean },
    ): Promise<{ error?: string }> {
        if (!isTerminal(args.target) || args.flagged) return {};

        try {
            await worktrees.reclaim(args.cardId);
            await events.append({
                project: args.project,
                cardId: args.cardId,
                stage: args.stage,
                type: 'worktree.reclaimed',
                payload: { cardId: args.cardId, target: args.target },
            });
            return {};
        } catch (err) {
            return { error: (err as Error).message };
        }
    }

    /**
     * Card 0104. Whether `card`'s effective scope collides with a card currently in flight elsewhere
     * on the board, and if so, which card and which patterns.
     *
     * `events` and `stages` are taken as parameters for the same reason `reclaimIfTerminal`'s
     * `worktrees`/`events` are: this class has no `EventLog` or stage-config dependency of its own,
     * and a caller that already holds both (`CardStageJob`, and now `Poller` — see poller.ts) can
     * share this one decision without the abstract class growing dependencies neither its contract
     * nor its Postgres implementation otherwise needs. `hasLiveClaim`, below, is the same idea applied
     * to card 0128's fix: this class has no queue or job-tracking dependency of its own either, so
     * that question is answered by the Postgres implementation instead of by importing one in.
     *
     * Compares `effectiveScope` — declared plus granted — on both sides, via `scopeOverlap`
     * (card 0069's proven matcher, reused rather than reimplemented) against every other card that
     * both `isRunningStage` and `hasLiveClaim` count as in flight — sitting in an agent stage is
     * necessary but not sufficient (card 0128): a card can sit there with nothing carrying it, and
     * only a live claim means something actually is. Returns the first collision found, not every
     * one: "which card and which files" is enough to act on, and a card can only be deferred once per
     * dispatch anyway.
     *
     * Card 0128: this is deliberately asymmetric in time, not merely in itself. If A is parked (no
     * claim) and B is then dispatched, B's own call here sees no conflict and proceeds — A is not
     * carrying anything yet. When A is later dispatched, its call sees B's claim and defers on B
     * instead. That is correct for a lock-free deferral — nothing here is acquired or held across the
     * two calls — and not a bug to "fix" into a symmetric reservation: a lock's lifetime would run to
     * merge, and merge is a human gate, which is card 0104's whole reason for choosing deferral over
     * one.
     */
    async scopeConflict(
        events: EventLog,
        project: string,
        card: Card,
        stages: ProjectStages,
    ): Promise<{ cardId: string; overlap: OverlappingPatterns[] } | undefined> {
        const mine = effectiveScope(card, await grantedPaths(events, project, card.frontmatter.id));

        for (const other of await this.list()) {
            if (other.frontmatter.id === card.frontmatter.id) continue;
            if (!isRunningStage(other, stages)) continue;
            if (!(await this.hasLiveClaim(project, other.frontmatter.id))) continue;

            const theirs = effectiveScope(other, await grantedPaths(events, project, other.frontmatter.id));
            const overlap = scopeOverlap(mine, theirs);
            if (overlap.length > 0) return { cardId: other.frontmatter.id, overlap };
        }

        return undefined;
    }

    /**
     * Card 0128. Whether a job is currently carrying `cardId` — `scopeConflict`'s live-claim half,
     * and the fix for the gridlock: a card sitting in an agent stage with nothing carrying it (it
     * deferred, or its chain stopped) must block nothing, and stage alone cannot tell the difference.
     *
     * Abstract, for the same reason `worktrees`/`events` are parameters on `reclaimIfTerminal` rather
     * than fields here: this class has no queue or job-tracking dependency of its own, and importing
     * one (`CardJobs`, `modules/jobs/card.jobs.ts`) would pull the jobs module's shape into a class the
     * jobs module itself already depends on (`CardJobs` takes `BoardConfig`, `CardStageJob` takes
     * `BoardRepository`) — the reverse import would make the two modules depend on each other. The
     * Postgres implementation answers this by reading `runner.card_jobs` directly instead.
     */
    abstract hasLiveClaim(project: string, cardId: string): Promise<boolean>;
}
