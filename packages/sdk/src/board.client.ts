import type {
    BoardColumns,
    CardDetail,
    CardDivision,
    CardEvent,
    CardSummary,
    CardVersion,
    CreateCardRequest,
    DependCardRequest,
    EditCardRequest,
    ImportBoardRequest,
    ImportReport,
    ListQuery,
    MoveCardRequest,
    PlanSession,
    ReleaseResult,
    RepositionCardRequest,
    SaveDraftRequest,
    SplitCardsRequest,
    SplitResult,
} from './types/board.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [board.ck](file://./../../../apps/api/data/contracts/board.ck)
 */
export class BoardClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List cards */
    async listCards(): Promise<CardSummary[]> {
        const result = await this.fetch(`/api/cards`, { method: 'GET' });
        return await parseJson<CardSummary[]>(result);
    }

    /** @name Create card */
    async createCard(body: CreateCardRequest): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<CardDetail>(result);
    }

    /** @name Get card */
    async getCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}`, { method: 'GET' });
        return await parseJson<CardDetail>(result);
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
        return await parseJson<CardDetail>(result);
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
        return await parseJson<CardDetail>(result);
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
        return await parseJson<CardDetail>(result);
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
        return await parseJson<CardDetail>(result);
    }

    /** @name Acknowledge a flagged card */
    async acknowledgeAFlaggedCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/ack`, { method: 'POST' });
        return await parseJson<CardDetail>(result);
    }

    /** @name Approve card plan */
    async approveCardPlan(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/approve`, { method: 'POST' });
        return await parseJson<CardDetail>(result);
    }

    /** @name Start card */
    async startCard(id: string): Promise<CardDetail> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/start`, { method: 'POST' });
        return await parseJson<CardDetail>(result);
    }

    /** @name Release card */
    async releaseCard(id: string): Promise<ReleaseResult> {
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/release`, { method: 'POST' });
        return await parseJson<ReleaseResult>(result);
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
        return await parseJson<SplitResult>(result);
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
        return await parseJson<CardDetail>(result);
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

    /** @name List card events */
    async listCardEvents(id: string, query?: ListQuery): Promise<CardEvent[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/events${qs}`, {
            method: 'GET',
        });
        return await parseJson<CardEvent[]>(result);
    }

    /** @name List card versions */
    async listCardVersions(id: string, query?: ListQuery): Promise<CardVersion[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/cards/${encodeURIComponent(id)}/versions${qs}`, {
            method: 'GET',
        });
        return await parseJson<CardVersion[]>(result);
    }

    /** @name List board columns */
    async listBoardColumns(): Promise<BoardColumns> {
        const result = await this.fetch(`/api/stages`, { method: 'GET' });
        return await parseJson<BoardColumns>(result);
    }

    /**
     * @name Initialise board
     * @description Scaffolds `BoardConfig.boardRoot`: cards/, config/, context/, a stages.yaml an operator can start a
     * card against immediately, and a git repo to commit it into. The API has to be running, with
     * PROJECT_BOARD_ROOT already pointing at the intended path, before it can create the board there —
     * that circularity is real, and the 409 below is what makes it legible instead of a connection
     * refused with no explanation.
     */
    async initialiseBoard(): Promise<BoardColumns> {
        const result = await this.fetch(`/api/board/init`, { method: 'POST' });
        return await parseJson<BoardColumns>(result);
    }

    /**
     * @name Import legacy board
     * @description One-time import of the legacy markdown board (cards/*.md) into Postgres. Refuses a board that
     * already has cards, the same guard `BoardImporter` always made, over HTTP now rather than only
     * from the CLI.
     */
    async importLegacyBoard(body: ImportBoardRequest): Promise<ImportReport> {
        const result = await this.fetch(`/api/board/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<ImportReport>(result);
    }
}
