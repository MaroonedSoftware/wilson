import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { Kysely } from 'kysely';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { toCardDetail } from '#modules/board/board.service.js';
import { PLAN_SECTIONS, filesInScope, sectionsOf, type Card } from '#modules/board/card.js';
import { git } from '#modules/board/git.js';
import { findStage, loadStages, type StageConfig } from '#modules/stages/stage.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { DB } from '#modules/data/db.js';
import { planFeed } from './plan.session.feed.js';
import { planSessions } from './plan.session.registry.js';
import { PlanTurnRepository, type PlanTurn as StoredPlanTurn } from './plan.turn.repository.js';
import type { CardDetail, PlanSession, PlanTurn, PlanTurnRequest, SaveDraftRequest } from '../../generated/board.js';

/** The same six headings `card create` seeds, built from the shared constant so the two cannot drift. */
const SKELETON = PLAN_SECTIONS.map(section => `## ${section}\n`).join('\n');

/**
 * A path that is not `worktreeRoot/<cardId>` — `WorktreeManager.create`/`reclaim` key on whatever id
 * they are handed, so a synthetic one buys a wholly separate tree without ever touching the card's
 * real worktree (card 0058's guard).
 */
const planId = (cardId: string): string => `plan-${cardId}`;

/** A branch that is not the card's own, for the same reason `planId` is not the card's own path. */
const planBranch = (cardId: string): string => `wilson-plan/${cardId}`;

/**
 * The server half of `wilson card plan`, split from the half that must run on the operator's own
 * terminal (card 0077).
 *
 * `open` runs card 0058's guards, cuts the throwaway worktree and seeds the draft file; `save`
 * validates a finished draft and writes it as a new card version; `close` reclaims the worktree and
 * its branch. What is deliberately absent: spawning `claude` itself (needs the operator's stdio, a
 * request/response cannot do that) and the confirmation prompt ("approval is explicit and versioned"
 * stays at the terminal, card 0074's job when it points the CLI at this).
 *
 * There is no session table. A session's identity — its worktree path and its branch — is
 * deterministic from the card id (`planId`/`planBranch` above), so "close a session" and "open a new
 * one for the same card" are both just those two functions of the same id: at most one live session
 * per card, and a CLI that died mid-conversation is recovered by opening again, which reclaims
 * whatever `create` finds in its way (`WorktreeManager.create` already reclaims before cutting).
 */
@Injectable()
export class PlanService {
    /** `PlanTurnRepository` has no polymorphic swap and no DI registration of its own — see its
     * class doc comment for why `new`, built from two dependencies this class already carries, is
     * simpler than adding one. */
    private readonly planTurns: PlanTurnRepository;

    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly worktrees: WorktreeManager,
        private readonly db: Kysely<DB>,
    ) {
        this.planTurns = new PlanTurnRepository(this.boardConfig, this.db);
    }

    /**
     * Open a planning session for a card in `planning`. Refuses, and cuts nothing, for a card
     * outside `planning` or whose real branch already has work — re-planning a card with code on it
     * is a different, more dangerous operation. Mirrors `wilson card plan`'s guards exactly.
     */
    async open(id: string): Promise<PlanSession> {
        const card = await this.readOrThrow(id);
        await this.assertPlannable(id, card);
        return this.cutSession(id, card);
    }

    /**
     * One turn of the conversation the daemon can now hold for a card in `planning`, instead of
     * that conversation existing only inside an operator's terminal. Appends the user's turn, hands
     * it to the registry's live session (rehydrating it from `runner.plan_turns`'s last
     * `engine_session_id` when this process holds none), publishes assistant text to `planFeed` as
     * it arrives, and appends the assistant's turn once it completes.
     *
     * Refused by exactly `open`'s own two guards — a card outside `planning`, or one whose real
     * branch already has work — via the same `assertPlannable` `open` itself calls, rather than a
     * copy of them.
     *
     * The very first turn for a card cuts (or re-cuts, harmlessly — nothing has touched the code
     * worktree yet, since the finished plan is written to `draftPath`, outside it) the same
     * throwaway worktree `open` cuts, by calling `cutSession` — this class's own method, not a
     * duplicate of it — and prepends the `planning` stage's instructions to the very first prompt
     * the engine ever sees. Every later turn resumes that same conversation instead: the model's
     * own context, not `runner.plan_turns`, is what carries the instructions forward from there
     * (this card's Constraints — never rebuild model context by replaying stored turns into a fresh
     * session).
     */
    async turn(id: string, request: PlanTurnRequest): Promise<PlanTurn> {
        return toGeneratedTurn(await this.appendTurn(id, request));
    }

    /**
     * `turn`'s actual work, kept separate from the shape it hands back over HTTP: `PlanTurnRepository`
     * rows carry `engineSessionId` — the live engine's own session id, needed to rehydrate a
     * conversation after a restart — but that is an internal implementation detail of this service,
     * never part of the contract `board.ck` declares for `POST .../plan/turn`. `toGeneratedTurn`
     * strips it before anything is handed to a caller, so the wire response can never leak it.
     */
    private async appendTurn(id: string, request: PlanTurnRequest): Promise<StoredPlanTurn> {
        const card = await this.readOrThrow(id);
        await this.assertPlannable(id, card);
        const text = request.text;

        const priorTurns = await this.planTurns.since(id, 0);
        const isFirstTurn = priorTurns.length === 0;

        // Two branches rather than one ternary assigning a shared variable: `cutSession` and
        // `existingSession` return different shapes (only the first carries `instructions`, which
        // only the first turn ever needs), and keeping them apart here is what lets the compiler
        // catch a later turn accidentally reaching for a field `existingSession` never promised.
        let worktreePath: string;
        let model: string;
        let prompt: string;
        if (isFirstTurn) {
            const session = await this.cutSession(id, card);
            worktreePath = session.worktreePath;
            model = session.model;
            prompt = `${session.instructions}\n\n${text}`;
        } else {
            const session = await this.existingSession(id);
            worktreePath = session.worktreePath;
            model = session.model;
            prompt = text;
        }

        await this.planTurns.append(id, 'user', text);

        // `planSessions.session` resolves `resume` itself, from `runner.plan_turns`'s last
        // `engine_session_id`, on a miss — never passed here, so a process restart rehydrates the
        // engine's own conversation regardless of what `isFirstTurn` says about this card's stored
        // transcript.
        const agent = await planSessions.session(id, { worktreeRoot: worktreePath, model }, this.planTurns);

        let assistantText = '';
        for await (const chunk of agent.turn(prompt)) {
            assistantText += chunk;
            planFeed.status(this.boardConfig.project, id, chunk);
        }

        return this.planTurns.append(id, 'assistant', assistantText, agent.sessionId);
    }

    /**
     * Validate a finished draft and write it as a new card version. Refuses, naming what is
     * missing, for a section that is absent or empty, or an empty "Files in scope" — the same two
     * refusals `wilson card plan` makes before writing today, so a card cannot die at
     * `assertDispatchable` three stages later for a plan this endpoint should have caught.
     *
     * An unchanged body writes nothing, the same no-op `BoardWriteService.edit` already makes — the
     * confirmation that this draft should be written at all already happened at the caller's
     * terminal before this was ever sent.
     */
    async save(id: string, request: SaveDraftRequest): Promise<CardDetail> {
        const before = await this.readOrThrow(id);
        if (request.body === before.body) {
            return toCardDetail(before);
        }

        const sections = sectionsOf(request.body);
        const missing = PLAN_SECTIONS.filter(section => !sections[section] || sections[section]!.trim().length === 0);
        if (missing.length > 0) {
            throw httpError(400).withDetails({ reason: `draft is incomplete — empty section(s): ${missing.join(', ')}` });
        }

        const draftCard: Card = { frontmatter: before.frontmatter, sections, body: request.body };
        if (filesInScope(draftCard).length === 0) {
            throw httpError(400).withDetails({ reason: 'draft has an empty "Files in scope"' });
        }

        await this.boardRepository.write(id, `Plan ${id}: ${before.frontmatter.title}`, current => ({ ...current, body: request.body }));
        return toCardDetail(await this.boardRepository.read(id));
    }

    /**
     * Reclaim a session's worktree and delete its throwaway branch. Idempotent, and safe to call for
     * a session that was never saved, or never opened at all: `WorktreeManager.reclaim` is already
     * safe to call on nothing there, and the branch delete is best-effort for the same reason.
     *
     * Only ever removes `planId(id)`/`planBranch(id)` — never the card's own worktree or branch,
     * since neither was ever the card's own to begin with.
     */
    async close(id: string): Promise<void> {
        // Disposes the live session, if this process is holding one — leaving the stored turns in
        // `runner.plan_turns` untouched, exactly as reclaiming the worktree below leaves the saved
        // draft version untouched. Idempotent for the same reason `planSessions.dispose` itself is.
        planSessions.dispose(id);
        await this.worktrees.reclaim(planId(id));
        await git(this.boardConfig.codeRoot, ['branch', '-D', planBranch(id)]).catch(() => undefined);
    }

    private async readOrThrow(id: string): Promise<Card> {
        try {
            return await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
    }

    /**
     * Card 0058's two guards, exactly as `open` always ran them, now shared with `turn` (this
     * card's acceptance criteria: "a turn for a card outside `planning`, or one whose real branch
     * already has work, is refused by the same guards `open` applies") — refuses, naming why, a
     * card that is not in `planning` or whose real branch already has work.
     */
    private async assertPlannable(id: string, card: Card): Promise<void> {
        if (card.frontmatter.stage !== 'planning') {
            throw httpError(400).withDetails({
                reason: `${id} is in stage "${card.frontmatter.stage}", not "planning" — move it there first`,
            });
        }

        const cardBranch = this.worktrees.resolveBranch(card);
        if (await this.worktrees.hasWork(cardBranch)) {
            throw httpError(400).withDetails({
                reason: `${id} already has work on ${cardBranch} — re-planning a card with code is a different, more dangerous operation`,
            });
        }
    }

    /**
     * Cuts (or re-cuts) the throwaway worktree and seeds the draft file — `open`'s own body, moved
     * here so `turn` can call it for a card's very first turn without duplicating it. Safe to call
     * more than once for the same card as long as nothing has written to the code worktree since:
     * `WorktreeManager.create` resets it to a fresh checkout, and the one file a planning session
     * actually writes, `draftPath`, lives outside that worktree entirely.
     */
    private async cutSession(id: string, card: Card): Promise<PlanSession> {
        // Config, not a string here: the stage's model and its planning instructions live in
        // stages.yaml like every other stage's do.
        const stage = await this.loadPlanningStage();

        // Seeded beside where a running stage's plan.md lands, per `materializePlan` — this is that
        // same directory, before the plan exists.
        const draftDir = join(this.boardConfig.runRoot, 'cards', id);
        await mkdir(draftDir, { recursive: true });
        const draftPath = join(draftDir, 'draft.md');

        const hasSections = Object.keys(sectionsOf(card.body)).length > 0;
        const seed = hasSections ? card.body : SKELETON;
        await writeFile(draftPath, seed, 'utf8');

        const worktree = await this.worktrees.create(planId(id), planBranch(id));

        // The stage's own instructions, plus the one fact only this session knows: where the draft
        // lives. Travels as one string so a caller appends it as the spawned agent's system prompt,
        // which the model sees with the same weight it gives its base instructions.
        const instructions = [
            stage.instructions,
            '',
            `Write the finished plan to ${draftPath} — that file, and only that file, is how the plan is`,
            `delivered. It currently holds ${
                hasSections ? "this card's existing body" : 'an empty six-heading skeleton'
            }; read it before anything else.`,
        ].join('\n');

        return {
            sessionId: id,
            worktreePath: worktree.path,
            draftPath,
            model: stage.model,
            instructions,
        };
    }

    /**
     * The worktree path and model for a card's already-open session, without touching the worktree
     * or the draft file — `turn`'s path for every turn after the first, where re-running
     * `cutSession` would reset the code worktree out from under a conversation already in flight.
     *
     * The path is computed the identical deterministic way `WorktreeManager.create` computes it
     * (`<worktreeRoot>/<planId(id)>`) rather than asked of `WorktreeManager` itself: that class
     * offers no "the path for this id" query that does not also cut or reclaim, and this call must
     * do neither.
     */
    private async existingSession(id: string): Promise<Pick<PlanSession, 'worktreePath' | 'model'>> {
        const stage = await this.loadPlanningStage();
        return { worktreePath: join(this.boardConfig.worktreeRoot, planId(id)), model: stage.model };
    }

    /** The `planning` stage's own config — shared by `cutSession` and `existingSession` so neither
     * inlines its own `loadStages`/`findStage` call. */
    private async loadPlanningStage(): Promise<StageConfig> {
        const stages = await loadStages(this.boardConfig.boardRoot);
        return findStage(stages, 'planning');
    }
}

/**
 * The generated contract's `PlanTurn` — `seq`, `role`, `content`, `createdAt` — never the stored
 * row's `engineSessionId`, which exists only so `PlanService` can rehydrate the engine's own
 * conversation and has no business on the wire. Exported, not a private method, so
 * `PlanStreamRouter` (`routes.setup.ts`) can strip the same field from a replayed row before
 * writing it to an SSE event, the same way `PlanService.turn` already strips it from a fresh one —
 * one mapping, not two copies that could drift.
 */
export function toGeneratedTurn(stored: StoredPlanTurn): PlanTurn {
    return { seq: stored.seq, role: stored.role, content: stored.content, createdAt: stored.createdAt };
}
