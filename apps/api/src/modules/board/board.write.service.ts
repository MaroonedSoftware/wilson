import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { Logger } from '@maroonedsoftware/logger';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { loadStages, findStage, validTargets } from '#modules/stages/stage.config.js';
import { whyNotDispatchable } from '#modules/jobs/dispatchable.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/card.stage.job.js';
import type { CardDetail, CreateCardRequest, MoveCardRequest, EditCardRequest, DependCardRequest, ReleaseResult } from '../../generated/board.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { CardNotFoundError } from './postgres.board.repository.js';
import { toCardDetail } from './board.service.js';
import { filesInScope, type Card } from './card.js';

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
        private readonly cardJobs: CardJobs,
        private readonly broker: JobBroker,
        private readonly runningCards: RunningCards,
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

    /**
     * Record or drop a dependency between two cards. Mirrors `wilson card depend`: a no-op request
     * (adding one already present, or dropping one already absent) writes nothing.
     *
     * `dependsOnId` is read first, before `id`, so a typo in the target reads as "that card does not
     * exist" rather than the referential-integrity violation `syncDeps` would otherwise surface —
     * same order the CLI reads in, same reason.
     *
     * Not `writeWithEvent`: this edits `dependsOn`, it does not transition the card's stage, so it is
     * `board.write` like `edit` above, not a recorded transition like `move`/`ack`/`approve`.
     */
    async depend(id: string, request: DependCardRequest): Promise<CardDetail> {
        const dependsOnId = request.dependsOnId;
        const remove = request.remove ?? false;

        if (id === dependsOnId) {
            throw httpError(400).withDetails({ reason: 'a card cannot depend on itself' });
        }

        await this.readOrThrow(dependsOnId);
        const before = await this.readOrThrow(id);

        const has = before.frontmatter.dependsOn.includes(dependsOnId);
        if (remove && !has) return toCardDetail(before);
        if (!remove && has) return toCardDetail(before);

        const dependsOn = remove
            ? before.frontmatter.dependsOn.filter(depId => depId !== dependsOnId)
            : [...before.frontmatter.dependsOn, dependsOnId].sort();

        await this.boardRepository.write(id, `${remove ? 'Drop' : 'Add'} ${id} dependency on ${dependsOnId}`, card => ({
            ...card,
            frontmatter: { ...card.frontmatter, dependsOn },
        }));

        return toCardDetail(await this.boardRepository.read(id));
    }

    /**
     * Clear a card's `needsHuman` flag and give its current stage its retry budget back. Mirrors
     * `wilson card ack`: does not move the card — it was flagged in the stage it failed in, and that
     * is where it should try again — and only touches that stage's retry counter.
     */
    async ack(id: string): Promise<CardDetail> {
        const before = await this.readOrThrow(id);
        if (!before.frontmatter.needsHuman) {
            throw httpError(400).withDetails({ reason: `${id} is not flagged for a human — nothing to acknowledge` });
        }

        const stage = before.frontmatter.stage;
        const reason = before.frontmatter.needsHumanReason;
        const droppedRetries = before.frontmatter.retries[stage];

        await this.boardRepository.writeWithEvent(
            id,
            `Ack ${id}`,
            current => {
                // Drop `needsHuman`/`needsHumanReason` entirely rather than setting them false/undefined,
                // and drop the current stage's retry key entirely rather than zeroing it — an absent key
                // is what "never failed" looks like, and a key present with a falsy value is a second
                // shape for the same state.
                const { needsHuman: _needsHuman, needsHumanReason: _needsHumanReason, ...rest } = current.frontmatter;
                const { [current.frontmatter.stage]: _dropped, ...retries } = current.frontmatter.retries;
                return {
                    ...current,
                    frontmatter: { ...rest, retries },
                };
            },
            {
                project: this.boardConfig.project,
                cardId: id,
                stage,
                type: 'card.acked',
                payload: { stage, reason, retries: droppedRetries, by: 'human' },
            },
        );

        return toCardDetail(await this.boardRepository.read(id));
    }

    /**
     * Approve a card's plan, pinning it and moving the card out of `backlog`. Mirrors `wilson card
     * approve`, including the version it pins: `writeIn` snapshots the card *after* the mutate
     * callback returns, so `currentVersion` read from inside it still returns the version from
     * *before* this write — the one holding the plan text just approved, not the version this
     * approval itself is about to create. That looks off by one and is not. Leave it.
     */
    async approve(id: string): Promise<CardDetail> {
        const card = await this.readOrThrow(id);
        if (card.frontmatter.stage !== 'backlog') {
            throw httpError(400).withDetails({ reason: `cannot approve ${id}: it is in "${card.frontmatter.stage}", not "backlog"` });
        }

        // An empty "Files in scope" would dispatch straight into `NotDispatchableError`'s
        // `empty-scope` case later, with nothing writable for the stage to act on.
        if (filesInScope(card).length === 0) {
            throw httpError(400).withDetails({ reason: `cannot approve ${id}: its plan's "Files in scope" is empty — nothing would be writable` });
        }

        // Where approval sends the card: `backlog`'s own `onPass` target, not a hard-coded
        // `implementing`. Stages are config, not code (PROJECT.md decision 8).
        const stages = await loadStages(this.boardConfig.boardRoot);
        const target = findStage(stages, 'backlog').onPass;

        const payload: Record<string, unknown> = { from: 'backlog', to: target, by: 'human' };

        await this.boardRepository.writeWithEvent(
            id,
            `Approve ${id}`,
            async current => {
                const pinnedVersion = await this.boardRepository.currentVersion(id);
                payload.planVersionId = pinnedVersion;
                return {
                    ...current,
                    frontmatter: { ...current.frontmatter, stage: target, planVersionId: pinnedVersion },
                };
            },
            {
                project: this.boardConfig.project,
                cardId: id,
                stage: target,
                type: 'transition.written',
                payload,
            },
        );

        return toCardDetail(await this.boardRepository.read(id));
    }

    /**
     * Enqueue a card's current stage on the job queue. Mirrors `wilson card start`: refuses whatever
     * `whyNotDispatchable` refuses, and a card a job is already carrying, before enqueuing — and
     * enqueues via `broker.send` then `cardJobs.record`, in that order, so the claim never precedes
     * the job.
     *
     * Unlike the CLI, there is no `PgBoss.start()`/`stop()` here: the CLI opens and closes pg-boss by
     * hand because johnny5's bootstrap never runs module `start` hooks, so nothing has connected it.
     * The server does run `start` hooks (`JobsModule.start`, see `setup.server.ts`), so `JobBroker` is
     * already connected by the time a request reaches this service.
     */
    async start(id: string): Promise<CardDetail> {
        const card = await this.readOrThrow(id);

        const stages = await loadStages(this.boardConfig.boardRoot);
        const notDispatchable = whyNotDispatchable(card, stages);
        if (notDispatchable) {
            throw httpError(400).withDetails({ reason: notDispatchable.reason });
        }

        const running = await this.cardJobs.inFlight(id);
        if (running) {
            throw httpError(400).withDetails({ reason: `cannot enqueue ${id}: job ${running} is already carrying it` });
        }

        const jobId = await this.broker.send('card.stage', { cardId: id, stageName: card.frontmatter.stage });
        await this.cardJobs.record(id, jobId);

        return toCardDetail(card);
    }

    /**
     * Release a card whose job is stuck: cancel the job through the broker and clear the claim.
     * Mirrors `wilson card release` exactly, including the reason `JobRunner.start()` is not used
     * here either (card 0065): starting a full runner registers a worker for every job type and
     * begins draining the queue, which would make this service a second daemon rather than a
     * producer-only caller. `JobBroker`/`CardJobs` reach `send`/`cancel`/`getJob`-equivalent calls
     * without ever calling `work()` for anything, so nothing here can pick up, run or chain a stage.
     *
     * `inFlight` is checked before the in-flight disambiguation, not after: a card with no claim — or
     * one whose job already settled — is "nothing to release" regardless of what else is running.
     * Checking the disambiguation first would make every card look like a maybe-in-flight job
     * whenever anything at all is running.
     *
     * Card 0087 adds `releasedAs` to the response: which of the two safe-to-cancel cases this was,
     * so the CLI can say so rather than one message covering both. That needs the job's actual
     * broker state — `created`/`retry` versus `active` — which `inFlight` deliberately does not
     * hand back (it only ever answers "live or not", against `LIVE_STATES`), so it is asked for
     * again here rather than guessed at from anything else already in hand.
     */
    async release(id: string): Promise<ReleaseResult> {
        const jobId = await this.cardJobs.inFlight(id);
        if (!jobId) {
            throw httpError(400).withDetails({ reason: `${id} holds no claim — nothing to release` });
        }

        // Only a card that does hold a live claim needs disambiguating: is that claim genuinely being
        // worked right now, or just abandoned? Before card 0079, `wilson run` and the API could both
        // be draining the queue, so a `pgrep -f 'index.ts run'` for a second, possibly-live worker was
        // the only way to tell "no daemon left to finish this" from "something else out there might
        // still be on it". Now the API is the only daemon, and this method only ever runs inside it —
        // asking "is a daemon up" from in here is always true, so it answers nothing. What still
        // genuinely varies is `RunningCards`: whether *this* process's own `CardStageJob` handler is
        // mid-run on *this* card right now (see its doc in card.stage.job.ts — the same tracker
        // `stopCardStageJobs` reads to report shutdown abandonment). A claim `inFlight` still calls
        // live but that this process is not currently running is exactly a claim left behind by an
        // earlier process that crashed before it could clear or hand off — safe to release.
        if (this.runningCards.snapshot().includes(id)) {
            throw httpError(400).withDetails({
                reason: `${id}: job ${jobId} is claimed and this process is running it right now — it may genuinely be in flight`,
            });
        }

        // Which of the two cases this cancel is: `created`/`retry` is queued work nothing has
        // touched yet; `active` here is the one the check above just cleared as orphaned rather than
        // genuinely running. `getJob` can race a job settling on its own between this call and
        // `inFlight`'s — rare, and low-stakes here since the job is being cancelled either way — and
        // that race resolves to the more common `queued` label rather than a third state of its own.
        const job = await this.broker.getJob('card.stage', jobId);
        const releasedAs: ReleaseResult['releasedAs'] = job?.state === 'active' ? 'orphan' : 'queued';

        // Cancel, not delete: a cancelled job leaves a record behind that explains the gap in the
        // card's history; a deleted one leaves nothing.
        await this.broker.cancel('card.stage', jobId);
        await this.cardJobs.clear(id);

        return { ...toCardDetail(await this.readOrThrow(id)), releasedAs };
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
