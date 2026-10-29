import { Injectable } from 'injectkit';
import type { DateTime } from 'luxon';
import type { AppendableCardEvent, EventLog } from '#modules/events/event.log.js';
import { findStage, StageConfigError, type ProjectStages } from '#modules/stages/stage.config.js';
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
 * Cap on how much of a card's event history {@link cardHistory} scans for `scope.granted` and
 * `work.committed` rows.
 *
 * `EventLog.tail` only ever returns the most recent `limit` rows (event.log.ts), and there is no
 * type-filtered query to fall back to — `event.log.ts` is outside this card's (0104) "Files in
 * scope". Generous rather than exact: a card whose event history runs past this before a grant, or
 * past it before its one commit, would still miss it, but that is the same shape of best-effort
 * every other caller of `tail` already accepts, not a new kind of gap.
 */
const GRANTED_PATHS_LOOKBACK = 2000;

/**
 * One tail read of `cardId`'s event history, answering the two questions {@link scopeConflict}
 * needs from it: every path granted via `request_scope` (the `scope.granted` events card 0069's
 * `ScopeGuard` records), and whether a `work.committed` event (`stage.dispatcher.ts`, written on
 * every passing commit) exists anywhere in that history. One `events.tail` call rather than two —
 * both answers come from the same rows, and the card 0240/0241 incident this card fixes is exactly
 * about not affording a second query per card per dispatch.
 */
const cardHistory = async (events: EventLog, project: string, cardId: string): Promise<{ grantedPaths: string[]; hasCommitted: boolean }> => {
    const rows = await events.tail(project, cardId, GRANTED_PATHS_LOOKBACK);
    return {
        grantedPaths: rows.filter(row => row.type === 'scope.granted').map(row => String((row.payload as { path?: unknown }).path)),
        hasCommitted: rows.some(row => row.type === 'work.committed'),
    };
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
 *
 * Card 0242: sitting here with a live claim is *also* not enough on its own. On 2026-09-19, card
 * 0240's `scope-check` — a readonly stage that reads the plan and writes nothing — held a live claim
 * and an agent-stage `isRunningStage` result, and that alone deferred card 0241's `testing`, one
 * stage from done, over a scope overlap neither card's tree yet contained anything of. See {@link
 * holdsFiles} for the further filter this added: a card counts only once something of it is actually
 * in the tree, not merely because it is being worked on.
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
 * Card 0242. Whether `other` — already past the `isRunningStage` and `hasLiveClaim` filters —
 * actually holds any of its files: something of it is in the tree, not merely a claim sitting on
 * top of a stage that has not touched anything yet.
 *
 * True when either half holds: its *current* stage's worktree is `'rw'` (it is writing to its
 * worktree right now, even before its first commit — a card on its first `implementing` run has no
 * `work.committed` event yet, and dropping it would let a second card write the same file
 * concurrently), or `hasCommitted` (its branch already carries at least one passing commit, so a
 * later readonly stage — `scope-check`, `review` — still holds what an earlier stage wrote, even
 * though its own worktree is read-only). The 0240/0241 incident this card fixes was a card in
 * `scope-check`, readonly and with no commit yet: neither half held, and today's code had no way to
 * tell.
 *
 * A stage `findStage` cannot resolve — not configured, or the config itself invalid — is treated as
 * holding: the conservative direction, since `isRunningStage` already returned `true` for the same
 * card only when `findStage` *did* resolve it as an agent stage, so this can only diverge from that
 * on a config that changed in between the two reads. Refusing to dispatch anything into that
 * uncertainty is cheaper than being wrong about whether a card holds its files.
 */
const holdsFiles = (other: Card, stages: ProjectStages, hasCommitted: boolean): boolean => {
    try {
        return findStage(stages, other.frontmatter.stage).worktree === 'rw' || hasCommitted;
    } catch (err) {
        if (err instanceof StageConfigError) return true;
        throw err;
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
     * Card 0091. Set a card's `position` and nothing else.
     *
     * Deliberately not `write`: `write`/`writeWithEvent` snapshot frontmatter and body into
     * `wilson.card_versions` on every call, which is right for a plan edit and wrong for a
     * reposition — a few minutes of tidying a column would bury the card's real history under
     * version rows whose body never changed. This updates the one column, mints no version, and
     * writes no event, matching ordering's status as not runner state (see the constraint on
     * `BoardWriteService.reposition`).
     */
    abstract setPosition(id: string, position: number): Promise<void>;

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
     * `isRunningStage`, `hasLiveClaim` *and* {@link holdsFiles} all count as in flight — sitting in an
     * agent stage with a live claim is necessary but not sufficient (card 0128, sharpened by card
     * 0242): a card can sit there, claimed, with nothing of it actually in the tree yet. Returns the
     * first collision found, not every one: "which card and which files" is enough to act on, and a
     * card can only be deferred once per dispatch anyway.
     *
     * Card 0242: `holdsFiles` is the third filter, added after `isRunningStage` and `hasLiveClaim`
     * proved not enough on their own. On 2026-09-19, card 0240 sat in `scope-check` — a readonly stage
     * that reads the plan and writes nothing — with a live claim, and that alone made this method
     * treat 0240 as holding its whole declared scope; card 0241's `testing`, one stage from done and
     * genuinely colliding on nothing 0240's tree yet contained, deferred on it anyway, and kept
     * deferring as 0240's claim carried on into `implementing`. Only the *other* card's side gets this
     * check — `card`, the one being dispatched, still compares its full effective scope regardless of
     * what it holds, matching card 0128's existing asymmetry below.
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
        const mine = effectiveScope(card, (await cardHistory(events, project, card.frontmatter.id)).grantedPaths);

        for (const other of await this.list()) {
            if (other.frontmatter.id === card.frontmatter.id) continue;
            if (!isRunningStage(other, stages)) continue;
            if (!(await this.hasLiveClaim(project, other.frontmatter.id))) continue;

            const theirHistory = await cardHistory(events, project, other.frontmatter.id);
            if (!holdsFiles(other, stages, theirHistory.hasCommitted)) continue;

            const theirs = effectiveScope(other, theirHistory.grantedPaths);
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
     * Postgres implementation answers this by reading `wilson.card_jobs` directly instead.
     */
    abstract hasLiveClaim(project: string, cardId: string): Promise<boolean>;
}
