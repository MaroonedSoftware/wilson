import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { toCardDetail } from '#modules/board/board.service.js';
import { PLAN_SECTIONS, filesInScope, sectionsOf, type Card } from '#modules/board/card.js';
import { git } from '#modules/board/git.js';
import { findStage, loadStages } from '#modules/stages/stage.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { CardDetail, PlanSession, SaveDraftRequest } from '../../generated/board.js';

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
    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly worktrees: WorktreeManager,
    ) {}

    /**
     * Open a planning session for a card in `planning`. Refuses, and cuts nothing, for a card
     * outside `planning` or whose real branch already has work — re-planning a card with code on it
     * is a different, more dangerous operation. Mirrors `wilson card plan`'s guards exactly.
     */
    async open(id: string): Promise<PlanSession> {
        const card = await this.readOrThrow(id);
        if (card.frontmatter.stage !== 'planning') {
            throw httpError(400).withDetails({
                reason: `${id} is in stage "${card.frontmatter.stage}", not "planning" — move it there first`,
            });
        }

        const cardBranch = this.worktrees.branchName(id, card.frontmatter.title);
        if (await this.worktrees.hasWork(cardBranch)) {
            throw httpError(400).withDetails({
                reason: `${id} already has work on ${cardBranch} — re-planning a card with code is a different, more dangerous operation`,
            });
        }

        // Config, not a string here: the stage's model and its planning instructions live in
        // stages.yaml like every other stage's do.
        const stages = await loadStages(this.boardConfig.boardRoot);
        const stage = findStage(stages, 'planning');

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
}
