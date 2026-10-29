import type {
    BoardColumns,
    CardDetail,
    CardDiff,
    CardDivision,
    CardEvent,
    CardSummary,
    CardUsage,
    CardVersion,
    CreateCardRequest,
    CreatePlanCommentRequest,
    DependCardRequest,
    EditCardRequest,
    LintFinding,
    ListQuery,
    MergeResult,
    MoveCardRequest,
    PlanComment,
    PlanDraft,
    PlanSession,
    PlanTurn,
    PlanTurnRequest,
    RecordFindingsRequest,
    ReleaseResult,
    RenameCardRequest,
    RepositionCardRequest,
    SaveDraftRequest,
    SplitCardsRequest,
    SplitResult,
} from './types/board.js';
import {
    reviveCardDetail,
    reviveCardEvent,
    reviveCardSummary,
    reviveCardVersion,
    reviveMergeResult,
    revivePlanComment,
    revivePlanTurn,
    reviveReleaseResult,
    reviveSplitResult,
} from './types/board.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [board.ck](../../../apps/api/data/contracts/board.ck)
 */
export class BoardClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List cards */
    async listCards(): Promise<CardSummary[]> {
        const result = await this.fetch(`/api/cards`, { method: 'GET' });
        return (await parseJson<CardSummary[]>(result)).map(reviveCardSummary);
    }

    /** @name Create card */
    async createCard(body: CreateCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /** @name Get card */
    async getCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}`, { method: 'GET' });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /**
     * @name Edit card body
     * @description Not `put`. This is a partial update — only the body changes, frontmatter is not editable here
     * (decision 5: stage, branch, retries are runner state; `move` is the recorded way to override
     * stage) — which is exactly what `patch` means and `put`, a full replace, does not.
     */
    async editCardBody(id: string, body: EditCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /**
     * @name Rename card
     * @description Card 0094. A sub-resource action, not `title` added to `EditCardRequest` (see the contract above):
     * renaming is still the same *kind* of act `PATCH .../id` already does — a human edits stored
     * content, no stage reads the field as input, nothing transitions — which is why this goes through
     * `board.write` in `BoardWriteService.rename`, not `writeWithEvent` the way `move` below does. It is
     * not part of `PATCH .../id` itself only because the contractkit-generated SDK method name for that
     * route (`editCardBody`) is pinned to "body", and a second field would force renaming it and every
     * caller for no behavioural gain.
     *
     * The title is not the runner state decision 5 protects, either: stage, branch and retries are
     * recomputed or read by the runner itself, and `move`/`ack`/etc. are the recorded ways to override
     * them. A title is authored prose nothing downstream depends on as input — the same reason `edit`
     * above is allowed to touch `body` freely.
     */
    async renameCard(id: string, body: RenameCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /**
     * @name Move card
     * @description A sub-resource action rather than `PATCH /api/cards/{id}` with a `stage` field: a move is a
     * recorded transition with its own event (`writeWithEvent`), not an edit to a stored field, and card
     * 0080's other five mutations — depend, ack, approve, start, release — are transitions of exactly
     * this shape. `POST .../move` establishes that convention once so five more operations can copy it
     * rather than each inventing its own.
     */
    async moveCard(id: string, body: MoveCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /**
     * @name Reposition card
     * @description Card 0091. Carries the drag an operator made in the parking lot down to a stored `position` — the
     * one other thing this surface lets an operator set that is not runner state (see the comment on
     * `options.security` and decision 5: the runner owns stage, branch, retries; this owns nothing the
     * runner reads). Persists through `BoardRepository.setPosition`, not `write`/`writeWithEvent`: a
     * reposition mints no card version and writes no `transition.written` event, on purpose — dragging a
     * card three rows down did not change what the runner will do with it. Follows the same sub-resource
     * shape `move` established above.
     */
    async repositionCard(id: string, body: RepositionCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/reposition`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /**
     * @name Set card dependency
     * @description Card 0080's other four mutations are pure transitions or a flag action; `depend` alone edits one
     * field (`dependsOn`) the way `PATCH .../id` edits `body` — it is still a POST action rather than a
     * PATCH because the edit is additive/subtractive (`remove`), not a full replace of the field the way
     * `EditCardRequest` replaces `body`.
     */
    async setCardDependency(id: string, body: DependCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/depend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /** @name Acknowledge a flagged card */
    async acknowledgeAFlaggedCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/ack`, { method: 'POST' });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /** @name Approve card plan */
    async approveCardPlan(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/approve`, { method: 'POST' });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /** @name Start card */
    async startCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/start`, { method: 'POST' });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /** @name Release card */
    async releaseCard(id: string): Promise<ReleaseResult> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/release`, { method: 'POST' });
        return reviveReleaseResult(await parseJson<ReleaseResult>(result));
    }

    /**
     * @name Merge card
     * @description Card 0143. The merge the pipeline could never do by hand: compute the card's branch merged into
     * `main` without a checkout, prove it against the project's suite, and land it — or refuse and say
     * why. Reachable from the app rather than automatic on reaching `ready` (see this card's own
     * Constraints): the trigger stays an explicit operator action, the same human gate `ready` always
     * was, this endpoint just performs what a human used to type by hand.
     */
    async mergeCard(id: string): Promise<MergeResult> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/merge`, { method: 'POST' });
        return reviveMergeResult(await parseJson<MergeResult>(result));
    }

    /**
     * @name Get card division
     * @description Card 0113. Reads without writing: renders the division a client would confirm, before anything is
     * created from it. Refuses, naming why, when there is nothing to act on rather than handing back an
     * empty confirmation prompt.
     */
    async getCardDivision(id: string): Promise<CardDivision> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/division`, { method: 'GET' });
        return await parseJson<CardDivision>(result);
    }

    /**
     * @name Split card
     * @description Card 0113. Creates one card per confirmed piece, in `planning`, records the dependencies named in
     * each piece's `dependsOn`, and annotates the origin card with the ids it produced. Never moves or
     * drops the origin — card [[0090]]'s lesson about stranding dependents applies here too, and the
     * pieces themselves are what would strand — and never re-runs `scope-check` on what it creates:
     * deciding a split is `scope-check`'s job (card 0105), this only acts on a division an operator
     * already confirmed.
     */
    async splitCard(id: string, body: SplitCardsRequest): Promise<SplitResult> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/split`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveSplitResult(await parseJson<SplitResult>(result));
    }

    /**
     * @name Lint a card plan
     * @description Card 0193. Checks a plan against the config the runner will actually enforce — a stage's
     * `CommandAllowlist`, the project's `alwaysAllowed` list, the literal shape of a `Files in scope`
     * line — and reports what it finds. Read-only, like `division` above: nothing here blocks `approve`
     * or any other transition (see `PlanLintService`'s own doc comment for why), so a client is free to
     * call this whenever it wants a second opinion, not only right before approving.
     */
    async lintACardPlan(id: string): Promise<LintFinding[]> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/lint`, { method: 'GET' });
        return await parseJson<LintFinding[]>(result);
    }

    /**
     * @name Open a planning session
     * @description Runs card 0058's two guards before cutting anything: refuses a card that is not in `planning`, and
     * refuses one whose real branch already has work (re-planning a card with code on it is a different,
     * more dangerous operation). Cuts nothing on a refusal.
     */
    async openAPlanningSession(id: string): Promise<PlanSession> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/open`, { method: 'POST' });
        return await parseJson<PlanSession>(result);
    }

    /**
     * @name Get a plan draft
     * @description Card 0140. A read, and nothing else: creates no session, cuts no worktree, writes nothing — `open`
     * remains the only thing that seeds a draft. A card in `planning` that has never had a session open
     * has no `draft.md` on disk yet; that is ordinary, not a server error, so it gets a 200 with an empty
     * `body` rather than a 404 — this surface's 404 already means "no such card" (see every other
     * operation here), and reusing it for "no draft yet" would leave a client unable to tell the two
     * apart without inspecting `details`. [[0138]] renders an empty draft the same way it renders any
     * other, with no special-case error path for a state that is completely normal.
     */
    async getAPlanDraft(id: string): Promise<PlanDraft> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/draft`, { method: 'GET' });
        return await parseJson<PlanDraft>(result);
    }

    /**
     * @name Save a plan draft
     * @description Validates the six `PLAN_SECTIONS` headings and a non-empty "Files in scope" server-side — the same
     * refusal `wilson card plan` makes before writing today, and it must not become something a client
     * can skip, since skipping it is what let a card die at `assertDispatchable` three stages later
     * (card 0058). Refuses naming what is missing. Writes exactly one new card version on success; an
     * unchanged body writes nothing, the same no-op `BoardWriteService.edit` already makes.
     */
    async saveAPlanDraft(id: string, body: SaveDraftRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /**
     * @name Close a planning session
     * @description Reclaims the session's worktree and deletes its throwaway branch. Idempotent — safe to call twice,
     * and safe to call for a session that opened but was never saved — because that is exactly what a CLI
     * dying mid-conversation leaves behind, and closing it must never itself be the operation that fails.
     */
    async closeAPlanningSession(id: string): Promise<void> {
        await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/close`, { method: 'POST' });
    }

    /**
     * @name Send a plan turn
     * @description Card 0133: one turn of the conversation the daemon can now hold for a card in `planning`, instead
     * of that conversation existing only inside an operator's terminal (`wilson card plan`). This is the
     * ordinary JSON half of the pair; `GET .../plan/stream` (mounted by hand beside `FeedRouter`, not
     * generated — see routes.setup.ts) is where a client watches that same reply stream in as it is
     * written. Refused by exactly the two guards `open` applies: a card outside `planning`, or one whose
     * real branch already has work.
     */
    async sendAPlanTurn(id: string, body: PlanTurnRequest): Promise<PlanTurn> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/turn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return revivePlanTurn(await parseJson<PlanTurn>(result));
    }

    /**
     * @name Add a plan comment
     * @description Card 0146. Records an open comment on a passage of a card's plan draft — the anchor a client
     * already captured plus what the person said. Comments never touch `plan.md`, a card version or
     * the card body (PROJECT.md: only the resulting plan text binds downstream stages); they reach the
     * agent only as anchored instructions prepended to the card's next `POST .../plan/turn`.
     */
    async addAPlanComment(id: string, body: CreatePlanCommentRequest): Promise<PlanComment> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return revivePlanComment(await parseJson<PlanComment>(result));
    }

    /**
     * @name List plan comments
     * @description Card 0146. Records an open comment on a passage of a card's plan draft — the anchor a client
     * already captured plus what the person said. Comments never touch `plan.md`, a card version or
     * the card body (PROJECT.md: only the resulting plan text binds downstream stages); they reach the
     * agent only as anchored instructions prepended to the card's next `POST .../plan/turn`.
     */
    async listPlanComments(id: string): Promise<PlanComment[]> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/comments`, { method: 'GET' });
        return (await parseJson<PlanComment[]>(result)).map(revivePlanComment);
    }

    /**
     * @name Resolve a plan comment
     * @description Card 0146. Marks one comment resolved — a state the comment moves through, not a delete; it
     * stays on record afterward, readable from `GET .../plan/comments`. The same 404 covers either id
     * not existing — the card, or a comment id not belonging to it.
     */
    async resolveAPlanComment(id: string, commentId: string): Promise<PlanComment> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/plan/comments/${encodeURIComponent(commentId)}/resolve`, {
            method: 'POST',
        });
        return revivePlanComment(await parseJson<PlanComment>(result));
    }

    /** @name List card events */
    async listCardEvents(id: string, query?: ListQuery): Promise<CardEvent[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/events${qs}`, {
            method: 'GET',
        });
        return (await parseJson<CardEvent[]>(result)).map(reviveCardEvent);
    }

    /**
     * @name Get card usage
     * @description Card 0263. Read-only, like `division`/`lint` above: nothing here recomputes or stores anything,
     * it only sums what `EventLog` already has. A card with no `stage.passed`/`stage.failed` events on
     * record gets zeros and an empty `stages` list, in a 200 — that is an ordinary card that has not
     * run yet, not the same fact as "no such card", which stays the 404 every other operation on this
     * surface gives.
     */
    async getCardUsage(id: string): Promise<CardUsage> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/usage`, { method: 'GET' });
        return await parseJson<CardUsage>(result);
    }

    /**
     * @name Get card diff
     * @description Card 0265. The one thing `ready`'s human gate could not do without a terminal: read the code a
     * card actually changed. `merge-base(main, branch)..branch`, the same range `wilson card diff`
     * already uses (this card's Constraints) — never `main..branch`, which would report every file
     * `main` gained since the fork as a deletion this card never made. Nothing here cuts, resumes or
     * reclaims a worktree; the branch's own history in `codeRoot`'s object database is enough to answer
     * this, so the endpoint still answers for a card whose worktree was already reclaimed.
     */
    async getCardDiff(id: string): Promise<CardDiff> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/diff`, { method: 'GET' });
        return await parseJson<CardDiff>(result);
    }

    /**
     * @name Record findings
     * @description Card 0266. Turns a human's line comments on the Diff tab into the same kind of kickback a failed
     * review already produces: folds every comment into the card's `## Review findings` section
     * (`withFindings`, marked as human-written so implementing can tell the two apart) and moves the
     * card to `ready`'s own configured `onFail` — read from the live stage config, never hard-coded to
     * `implementing`, so a board that points `ready.onFail` elsewhere still routes correctly with no
     * code change. Not a runner kickback: `retries` is left untouched (this is not a stage failing, it
     * is a human's review) and the event's `by` is `'human'`, the same convention `move` uses for an
     * operator-initiated transition.
     */
    async recordFindings(id: string, body: RecordFindingsRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/findings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveCardDetail(await parseJson<CardDetail>(result));
    }

    /** @name List card versions */
    async listCardVersions(id: string, query?: ListQuery): Promise<CardVersion[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/versions${qs}`, {
            method: 'GET',
        });
        return (await parseJson<CardVersion[]>(result)).map(reviveCardVersion);
    }

    /** @name List board columns */
    async listBoardColumns(): Promise<BoardColumns> {
        const result = await this.fetch(`/api/stages`, { method: 'GET' });
        return await parseJson<BoardColumns>(result);
    }

    /**
     * @name Initialise board
     * @description Gives the project a stage config an operator can start a card against immediately — a
     * `runner.stage_configs` row holding the default document. This used to scaffold the sibling board
     * repo (cards/, config/stages.yaml, context/, a git repo); the board is Postgres now, stage config
     * included, so the row is all there is to initialise, and no path is involved.
     */
    async initialiseBoard(): Promise<BoardColumns> {
        const result = await this.fetch(`/api/board/init`, { method: 'POST' });
        return await parseJson<BoardColumns>(result);
    }
}
