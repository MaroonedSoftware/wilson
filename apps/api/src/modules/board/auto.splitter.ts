import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { EventLog } from '#modules/events/event.log.js';
import { AUTO_SPLIT_ENABLED } from '#modules/settings/auto.split.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { SupportedRefusal } from '#modules/stages/stage.result.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository, type SplitWrite } from './board.repository.js';
import type { Card } from './card.js';
import { dependencyCycle, nextCardId, seedSplitBody, splitDepth, splitProblem } from './split.js';

/**
 * How many splits deep a card may be and still split automatically: a card that was never split and
 * its pieces may, their pieces may not. Cards 0153, 0155 and 0156 were each a further split of the one
 * before, and a division that keeps coming back too large is a plan a person should look at. Small
 * and fixed, the same posture `RE_REVIEW_CAP` (`board.write.service.ts`) takes.
 */
export const AUTO_SPLIT_MAX_DEPTH = 2;

/** What became of a refusal: `undefined` from {@link AutoSplitter.split} means the runner routes it as usual. */
export interface AutoSplitResult {
    /** The pieces this call created. Empty when another run of the same stage already split the card. */
    pieceIds: string[];
}

/**
 * Splits a card on a scope-check refusal the verifier supported, without an operator confirming the
 * division. Off unless `AUTO_SPLIT_ENABLED` is on for this project.
 *
 * Everything is decided inside {@link BoardRepository.applySplit}'s lock, against the board as it
 * stands, and everything is written in that one transaction, which is the whole of the idempotence
 * story. A crash part way writes nothing, so the retried stage starts clean. Once it commits the
 * origin has left `scope-check`, so a stale job is refused as `wrong-stage`, and a run that was
 * already racing finds the origin in `split` and reports {@link AutoSplitResult} with no pieces.
 *
 * The origin moves to the terminal `split` state rather than staying in `planning`, where it would
 * read as work to pick up. `unsatisfiedDependencies` derives its completion from its pieces whatever
 * stage it sits in, so a dependent waits for the pieces and is not stranded. Its own dependencies need
 * no copying: they were satisfied, or this stage could not have dispatched.
 *
 * Automation stops short of approval. `PlanDraftJob` drafts each piece's plan afterwards, and the
 * piece stays in `planning` until a person approves it, since reaching `backlog` needs that.
 *
 * A refusal this declines to act on falls back to the runner's ordinary kickback, with a
 * `card.auto-split-skipped` event saying why.
 */
@Injectable()
export class AutoSplitter {
    constructor(
        private readonly board: BoardRepository,
        private readonly config: BoardConfig,
        private readonly settings: SettingsStore,
        private readonly events: EventLog,
        private readonly logger: Logger,
    ) {}

    async split(cardId: string, stageName: string, refusal: SupportedRefusal): Promise<AutoSplitResult | undefined> {
        if (!(await this.settings.get(AUTO_SPLIT_ENABLED))) return undefined;

        let skipped: string | undefined;
        let alreadySplit = false;
        const plan = (origin: Card, cards: Card[]): SplitWrite | undefined => {
            if (origin.frontmatter.stage === 'split') {
                alreadySplit = true;
                return undefined;
            }
            skipped = this.whyNot(origin, cards, stageName, refusal);
            return skipped ? undefined : this.writeFor(origin, cards, stageName, refusal);
        };

        let write: SplitWrite | undefined;
        try {
            write = await this.board.applySplit(cardId, plan);
        } catch (err) {
            // Nothing was written. The likeliest cause is another writer taking one of the ids, and
            // the division stays on the event log for an operator to confirm.
            skipped = `the split could not be written: ${(err as Error).message}`;
        }

        if (alreadySplit) return { pieceIds: [] };
        if (write) {
            const pieceIds = write.pieces.map(piece => piece.card.frontmatter.id);
            this.logger.info(`auto-split ${cardId} into ${pieceIds.join(', ')}`);
            return { pieceIds };
        }

        this.logger.warn(`not auto-splitting ${cardId}: ${skipped}`);
        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'card.auto-split-skipped',
            payload: { reason: skipped },
        });
        return undefined;
    }

    /** Why this refusal must go to a person instead, or `undefined` when it can split. */
    private whyNot(origin: Card, cards: Card[], stageName: string, refusal: SupportedRefusal): string | undefined {
        const id = origin.frontmatter.id;
        if (origin.frontmatter.stage !== stageName) return `${id} moved to "${origin.frontmatter.stage}" while "${stageName}" ran`;
        if (cards.some(card => card.frontmatter.splitFrom === id)) return `${id} already has pieces`;

        const depth = splitDepth(origin, cards);
        if (depth >= AUTO_SPLIT_MAX_DEPTH) return `${id} is ${depth} splits deep, at the auto-split cap of ${AUTO_SPLIT_MAX_DEPTH}`;

        const problem = splitProblem(refusal.division);
        if (problem) return problem;

        const cycle = dependencyCycle(refusal.division);
        if (cycle.length > 0) return `pieces ${cycle.map(title => `"${title}"`).join(', ')} wait on each other`;
        return undefined;
    }

    private writeFor(origin: Card, cards: Card[], stageName: string, refusal: SupportedRefusal): SplitWrite {
        const id = origin.frontmatter.id;

        const titleToId = new Map<string, string>();
        let board = cards;
        const pieces = refusal.division.map(piece => {
            const pieceId = nextCardId(board);
            titleToId.set(piece.title, pieceId);
            const card: Card = {
                frontmatter: { id: pieceId, title: piece.title, stage: 'planning', dependsOn: [], retries: {}, splitFrom: id },
                sections: {},
                body: seedSplitBody(id, origin.frontmatter.title, piece),
            };
            board = [...board, card];
            return { card, message: `Auto-split ${id} into ${pieceId}: ${piece.title}` };
        });

        // A second pass, once every piece has an id: a piece may depend on one listed after it.
        refusal.division.forEach((piece, index) => {
            pieces[index]!.card.frontmatter.dependsOn = piece.dependsOn.map(title => titleToId.get(title)!).sort();
        });

        const pieceIds = pieces.map(piece => piece.card.frontmatter.id);
        const reason = `auto-split into ${pieceIds.join(', ')}`;
        return {
            pieces,
            origin: {
                ...origin,
                frontmatter: { ...origin.frontmatter, stage: 'split' },
                body: `${origin.body}\n\n---\n\nSplit automatically into: ${pieceIds.join(', ')}. Scope-check refused this card: ${refusal.reason}`,
            },
            originMessage: `Auto-split ${id} into ${pieceIds.join(', ')}`,
            events: [
                {
                    project: this.config.project,
                    cardId: id,
                    stage: stageName,
                    type: 'transition.written',
                    payload: { from: stageName, to: 'split', retries: origin.frontmatter.retries, by: 'runner', autoSplit: true, reason },
                },
                {
                    project: this.config.project,
                    cardId: id,
                    stage: stageName,
                    type: 'card.auto-split',
                    payload: {
                        pieces: pieces.map(({ card }) => ({ id: card.frontmatter.id, title: card.frontmatter.title })),
                        reason: refusal.reason,
                    },
                },
            ],
        };
    }
}
