import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { Logger } from '@maroonedsoftware/logger';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { loadStages, validTargets } from '#modules/stages/stage.config.js';
import type { CardDetail, CreateCardRequest, MoveCardRequest, EditCardRequest } from '../../generated/board.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { CardNotFoundError } from './postgres.board.repository.js';
import { toCardDetail } from './board.service.js';
import type { Card } from './card.js';

/**
 * The board's write surface — the service the generated `/api/cards*` `post`/`patch` handlers bind
 * to.
 *
 * A sibling of `BoardService` rather than a growing single class: the read surface is a thin
 * translation over `BoardRepository`, and these are not — each method here ports the actual
 * behaviour of a `wilson card ...` command (refusal rules, event payloads, worktree reclaim), which
 * is enough going on that folding it into `BoardService` would leave a reader unable to tell "reads
 * a shape" from "makes a decision" at a glance. Both share `toCardDetail`/`toCardSummary` from
 * `board.service.ts`, so a card looks the same on the wire whichever service produced it.
 *
 * Every method here reproduces a CLI command's behaviour, not just its outcome: same refusal
 * reasons, same version messages, same event payloads, same `by: 'human'`. That is deliberate —
 * card 0080 adds the other five mutations (depend, ack, approve, start, release) by copying this
 * service's shape, and a second implementation of a rule the CLI already got right is exactly the
 * drift this card exists to prevent.
 */
@Injectable()
export class BoardWriteService {
    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly worktrees: WorktreeManager,
        private readonly eventLog: EventLog,
        private readonly logger: Logger,
    ) {}

    /**
     * Create a card. Mirrors `wilson card create`: the id is the next sequential one over the
     * current board, never chosen by the caller, and a card lands in `parking-lot` unless told
     * otherwise.
     *
     * The CLI seeds `$EDITOR` with a skeleton and a human fills it in there; there is no terminal on
     * the other end of an HTTP call, so `body` is required here rather than defaulted — the caller
     * sends the finished plan text directly.
     */
    async create(request: CreateCardRequest): Promise<CardDetail> {
        const id = nextCardId(await this.boardRepository.list());
        const stage = request.stage ?? 'parking-lot';
        const card: Card = {
            frontmatter: { id, title: request.title, stage, dependsOn: [], retries: {} },
            sections: {},
            body: request.body,
        };

        await this.boardRepository.create(card, `Create ${id}: ${request.title}`);
        return toCardDetail(await this.boardRepository.read(id));
    }

    /**
     * Move a card to another stage, recording the transition. Mirrors `wilson card move`,
     * including its two edge cases: a move to the card's current stage still clears a `needsHuman`
     * flag rather than being a no-op, and a terminal target reclaims the card's worktree
     * (best-effort, never unwinding the transition that already committed).
     */
    async move(id: string, request: MoveCardRequest): Promise<CardDetail> {
        const target = request.stage;

        // Refuse a state the stage graph does not name, with the same reason `wilson card move`
        // gives — carried in `details` since `httpError`'s `message` is pinned to the status code's
        // default text (see the contract's `400:` comment on this operation).
        const targets = validTargets(await loadStages(this.boardConfig.boardRoot));
        if (!targets.includes(target)) {
            throw httpError(400).withDetails({ reason: `"${target}" is not a state this board defines. Valid: ${targets.join(', ')}` });
        }

        const before = await this.readOrThrow(id);

        // Moving a card by hand is already an operator saying they have looked, so a flag comes off
        // on any move — including the no-op case below, where the card is already in the target
        // stage.
        const clearsFlag = Boolean(before.frontmatter.needsHuman);
        if (before.frontmatter.stage === target && !clearsFlag) {
            return toCardDetail(before);
        }

        // The move and the event recording it commit together.
        await this.boardRepository.writeWithEvent(
            id,
            `Move ${id} to ${target}`,
            card => {
                const { needsHuman: _needsHuman, needsHumanReason: _needsHumanReason, ...rest } = card.frontmatter;
                return { ...card, frontmatter: { ...rest, stage: target } };
            },
            {
                project: this.boardConfig.project,
                cardId: id,
                stage: target,
                type: 'transition.written',
                payload: { from: before.frontmatter.stage, to: target, by: 'human' },
            },
        );

        // This is the operator's override, so it reclaims on the same rule the runner uses
        // (`isTerminal(target)`) rather than growing its own idea of "done". `clearsFlag` reflects
        // the card's state *before* this move, which is what must gate reclaiming even though this
        // same move is what clears the flag (card 0055 keeps a flagged card's tree on purpose).
        const reclaimed = await this.boardRepository.reclaimIfTerminal(this.worktrees, this.eventLog, {
            project: this.boardConfig.project,
            cardId: id,
            stage: target,
            target,
            flagged: clearsFlag,
        });
        if (reclaimed.error) {
            this.logger.warn(`could not reclaim worktree for ${id} after moving to "${target}": ${reclaimed.error}`);
        }

        return toCardDetail(await this.boardRepository.read(id));
    }

    /**
     * Edit a card's plan body. Mirrors `wilson card edit`: a no-op body writes nothing, so an
     * unchanged save does not add an empty version to the history.
     *
     * The CLI treats an empty `$EDITOR` session as "abandon" — a UX affordance for a closed editor,
     * not a rule about what a card's body may be. There is no equivalent over HTTP: `body` is a
     * value the caller sent deliberately, so it is written as given, including empty.
     */
    async edit(id: string, request: EditCardRequest): Promise<CardDetail> {
        const before = await this.readOrThrow(id);
        if (request.body === before.body) {
            return toCardDetail(before);
        }

        await this.boardRepository.write(id, `Edit ${id} plan body`, card => ({ ...card, body: request.body }));
        return toCardDetail(await this.boardRepository.read(id));
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

/**
 * The next id on the board. Sequential and zero-padded, matching `nextCardId` in
 * `packages/cli/src/commands/card/editor.ts` — duplicated rather than imported because the
 * dependency runs the other way (`packages/cli` depends on `@wilson/api`, not the reverse), and
 * this card does not touch CLI files.
 */
const nextCardId = (cards: Card[]): string => {
    const highest = cards.reduce((max, card) => Math.max(max, Number.parseInt(card.frontmatter.id, 10) || 0), 0);
    return String(highest + 1).padStart(4, '0');
};
