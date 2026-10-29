import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import { httpError } from '@maroonedsoftware/errors';
import { Logger } from '@maroonedsoftware/logger';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { DRY_RUN_ENABLED } from '#modules/settings/dry.run.setting.js';
import { RE_REVIEW_ON_MERGE } from '#modules/settings/re.review.on.merge.setting.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import { findStage, validTargets, type StageConfig } from '#modules/stages/stage.config.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import { pnpmStoreLock, runConfiguredCommand, type CommandFailure } from '#modules/stages/run.command.js';
import { describeFailingTest } from '#modules/stages/testing.verifier.js';
import { parseTestReport } from '#modules/stages/test.report.js';
import { whyNotDispatchable } from '#modules/jobs/dispatchable.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { ScopeCheckResultSchema } from '#modules/stages/stage.result.js';
import type {
    CardDetail,
    CardDivision,
    CreateCardRequest,
    MergeResult,
    MoveCardRequest,
    EditCardRequest,
    DependCardRequest,
    RecordFindingsRequest,
    RenameCardRequest,
    ReleaseResult,
    RepositionCardRequest,
    SplitCardsRequest,
    SplitResult,
} from '../../generated/board.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { CardNotFoundError } from './postgres.board.repository.js';
import { toCardDetail } from './board.service.js';
import { withFindings } from './append.findings.js';
import { git } from './git.js';
import { rankBetween, renormalizedPositions } from './card.position.js';
import { filesInScope, type Card } from './card.js';
import type { ReviewFinding } from '#modules/stages/stage.result.js';

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
        private readonly settings: SettingsStore,
        private readonly stageConfigs: StageConfigStore,
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
     * Card 0203. Create a card reported by a `CardSource`, carrying its external ref. `create`'s own
     * body, with two differences that are the whole point of this method: `stage` is always
     * `parking-lot`, never a caller's choice — a source may not promote, the same rule the card
     * poller follows (this card's Constraints) — and `frontmatter.external` records `{ [source]:
     * externalId }` so `InboundCardWriter` can find this card again on the next report.
     *
     * Internal rather than a wider `CreateCardRequest`: that type is generated from `board.ck` and has
     * no `external` field, and adding one there would change the generated code and the SDK for a
     * caller — a `CardSource` — that is not on the wire (this card's Constraints, "no HTTP surface").
     * Returns the stored `Card`, not a `CardDetail`: there is no wire contract for this method to
     * shape a response for, and `toCardDetail` does not carry `external` anyway.
     */
    async createFromSource(source: string, externalId: string, title: string, body: string): Promise<Card> {
        const id = nextCardId(await this.boardRepository.list());
        const card: Card = {
            frontmatter: { id, title, stage: 'parking-lot', dependsOn: [], retries: {}, external: { [source]: externalId } },
            sections: {},
            body,
        };

        await this.boardRepository.create(card, `Create ${id} from ${source} ${externalId}: ${title}`);
        return this.boardRepository.read(id);
    }

    /**
     * Move a card to another stage, recording the transition. Mirrors `wilson card move`,
     * including its two edge cases: a move to the card's current stage still clears a `needsHuman`
     * flag rather than being a no-op, and a terminal target reclaims the card's worktree
     * (best-effort, never unwinding the transition that already committed).
     *
     * Card 0127: entering `backlog` — from anywhere, `planning`, `parking-lot`, or a `scope-check`
     * refusal routed back through `planning` — is now the approval gate `approve` used to be. This
     * is the one place that pins the plan version and refuses an empty "Files in scope", so a card
     * this lets into `backlog` is always both approved and workable, whatever the source. Re-moving
     * a card already in `backlog` (the flag-clearing no-op-that-writes case below) does not re-pin —
     * it is not *entering* `backlog`, it is already there.
     */
    async move(id: string, request: MoveCardRequest): Promise<CardDetail> {
        const target = request.stage;

        // Refuse a state the stage graph does not name, with the same reason `wilson card move`
        // gives — carried in `details` since `httpError`'s `message` is pinned to the status code's
        // default text (see the contract's `400:` comment on this operation).
        const targets = validTargets(await this.stageConfigs.load());
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

        const enteringBacklog = target === 'backlog' && before.frontmatter.stage !== target;

        // Same refusal `approve` always made, carried to the new gate: an empty "Files in scope"
        // would dispatch straight into `NotDispatchableError`'s `empty-scope` case later, with
        // nothing writable for the stage to act on.
        if (enteringBacklog && filesInScope(before).length === 0) {
            throw httpError(400).withDetails({ reason: `cannot approve ${id}: its plan's "Files in scope" is empty — nothing would be writable` });
        }

        const payload: Record<string, unknown> = { from: before.frontmatter.stage, to: target, by: 'human' };

        // The move and the event recording it commit together.
        await this.boardRepository.writeWithEvent(
            id,
            `Move ${id} to ${target}`,
            async card => {
                const { needsHuman: _needsHuman, needsHumanReason: _needsHumanReason, ...rest } = card.frontmatter;
                if (!enteringBacklog) {
                    return { ...card, frontmatter: { ...rest, stage: target } };
                }

                // `writeIn` snapshots after this mutate returns, so `currentVersion` read from in
                // here still answers with the version *before* this write — the plan text just
                // approved, not the row this approval itself is about to create. That looks off by
                // one and is not. Leave it (this is `approve`'s own comment, carried here unchanged).
                const pinnedVersion = await this.boardRepository.currentVersion(id);
                payload.planVersionId = pinnedVersion;
                return { ...card, frontmatter: { ...rest, stage: target, planVersionId: pinnedVersion } };
            },
            {
                project: this.boardConfig.project,
                cardId: id,
                stage: target,
                type: 'transition.written',
                payload,
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
     * Card 0266. Turns a human's line comments off the Diff tab into a kickback — the same
     * `## Review findings` section a review's own findings land in (`withFindings`, reused rather
     * than a second, human-only section: implementing already reads that section, and it is
     * replaced rather than accumulated, so a human's list sheds on the next pass like any other),
     * and a move to `ready.onFail` read from the live stage config, never hard-coded to
     * `implementing` — the same reasoning `approve` above gives for reading `backlog.onPass`
     * instead of pinning a target in code.
     *
     * Every comment is a `defect`: it came from selecting a line in the diff, so it always has a
     * `file`/`line` to cite, and `severity` is the submitter's own choice — absent defaults to
     * `blocker`, since a human who stops a merge to write a comment is blocking it.
     *
     * Not a runner kickback, so none of `kickback.ts`'s bookkeeping applies: `retries` is carried
     * through untouched (bumping `retries.ready` would let three human reviews flag the card under
     * `maxKickbacks`, which is backwards — this is not a stage failing, it is a human reviewing) and
     * `needsHuman` is never set. The body write and the transition commit together through
     * `writeWithEvent`, one `transition.written` event carrying `by: 'human'` and a reason naming
     * the count, mirroring `reReviewOnOverlap`'s own runner-authored transition below.
     */
    async recordFindings(id: string, request: RecordFindingsRequest): Promise<CardDetail> {
        const before = await this.readOrThrow(id);
        if (before.frontmatter.stage !== 'ready') {
            throw httpError(400).withDetails({ reason: `cannot record findings on ${id}: it is in "${before.frontmatter.stage}", not "ready"` });
        }
        if (request.findings.length === 0) {
            throw httpError(400).withDetails({ reason: `cannot record findings on ${id}: no comments were submitted` });
        }

        const stages = await this.stageConfigs.load();
        const target = findStage(stages, 'ready').onFail;

        const findings: ReviewFinding[] = request.findings.map(finding => ({
            severity: finding.severity ?? 'blocker',
            kind: 'defect',
            file: finding.file,
            line: finding.line,
            problem: finding.problem,
            suggestion: finding.suggestion,
        }));

        await this.boardRepository.writeWithEvent(
            id,
            `Record ${request.findings.length} human finding(s) on ${id}`,
            current => ({
                ...current,
                frontmatter: { ...current.frontmatter, stage: target },
                body: withFindings(current.body, findings, [], HUMAN_FINDINGS_NOTE),
            }),
            {
                project: this.boardConfig.project,
                cardId: id,
                stage: target,
                type: 'transition.written',
                payload: {
                    from: 'ready',
                    to: target,
                    by: 'human',
                    reason: `${request.findings.length} human finding(s) left on the diff`,
                },
            },
        );

        return toCardDetail(await this.boardRepository.read(id));
    }

    /**
     * Card 0091. Reposition a card within the parking lot. Refuses a card outside `parking-lot` —
     * ordering any other stage is the runner's business, not an operator's; no other stage's order
     * even means anything, since nothing reads it.
     *
     * Unversioned by design, unlike every mutation above: goes through `BoardRepository.setPosition`,
     * never `write`/`writeWithEvent`, so a reposition mints no card version and writes no
     * `transition.written` event — ordering is not runner state, so it carries none of the ceremony a
     * transition does.
     *
     * `beforeId`/`afterId` name the neighbours `id` should land between, not positions — a client has
     * no way to hand back a position value still valid by the time this request lands. A neighbour
     * that exists but was never itself positioned has nothing to rank against (its row sorts by `id`,
     * not a number); that is treated exactly like `rankBetween` reporting the gap between two real
     * positions is exhausted, both sending the column through one `renormalizedPositions` pass first —
     * preserving its current `position, id` order while giving every card in it a real, evenly spaced
     * position — before ranking `id` against the now-real neighbour values.
     */
    async reposition(id: string, request: RepositionCardRequest): Promise<CardDetail> {
        const card = await this.readOrThrow(id);
        if (card.frontmatter.stage !== 'parking-lot') {
            throw httpError(400).withDetails({ reason: `cannot reposition ${id}: it is in "${card.frontmatter.stage}", not "parking-lot"` });
        }

        const resolveNeighbour = async (neighbourId: string | undefined): Promise<Card | undefined> => {
            if (neighbourId === undefined) return undefined;
            if (neighbourId === id) {
                throw httpError(400).withDetails({ reason: `cannot reposition ${id}: it cannot be its own neighbour` });
            }
            const neighbour = await this.readOrThrow(neighbourId);
            if (neighbour.frontmatter.stage !== 'parking-lot') {
                throw httpError(400).withDetails({ reason: `cannot reposition ${id}: "${neighbourId}" is not a card in "parking-lot"` });
            }
            return neighbour;
        };

        const before = await resolveNeighbour(request.beforeId);
        const after = await resolveNeighbour(request.afterId);

        // The column's current sort, `id` excluded — what `renormalizedPositions` preserves if a
        // renormalise turns out to be needed below, and what the ordering checks just below trust as
        // ground truth for "which neighbour is really first".
        const order = (await this.boardRepository.list())
            .filter(other => other.frontmatter.stage === 'parking-lot' && other.frontmatter.id !== id)
            .map(other => other.frontmatter.id);

        // Both omitted only means "the column is empty but for this card" — a populated column with
        // no neighbours named is a caller that forgot to say where the card lands, not a request for
        // the empty-column midpoint `rankBetween(undefined, undefined)` would otherwise hand back.
        if (before === undefined && after === undefined && order.length > 0) {
            throw httpError(400).withDetails({
                reason: `cannot reposition ${id}: "beforeId"/"afterId" must say where it lands unless "parking-lot" holds only this card`,
            });
        }

        // `before` and `after` are supposed to be `id`'s actual neighbours, which means `before` must
        // really sort ahead of `after` in the column today — the same card named on both sides, or
        // the two named in the reverse of their real order, both fail this. Caught here, with the
        // same refusal every other bad input to this method gets, rather than left to surface as the
        // "unreachable" throw below once ranking and renormalising both give up on an inverted pair.
        if (before !== undefined && after !== undefined && order.indexOf(before.frontmatter.id) >= order.indexOf(after.frontmatter.id)) {
            throw httpError(400).withDetails({
                reason: `cannot reposition ${id}: "${before.frontmatter.id}" does not come before "${after.frontmatter.id}" in "parking-lot"`,
            });
        }

        const rankable = (neighbour: Card | undefined): boolean => neighbour === undefined || neighbour.frontmatter.position !== undefined;

        let ranked =
            rankable(before) && rankable(after) ? rankBetween(before?.frontmatter.position, after?.frontmatter.position) : { ok: false as const };

        if (!ranked.ok) {
            const spaced = renormalizedPositions(order);
            for (const [cardId, position] of spaced) {
                await this.boardRepository.setPosition(cardId, position);
            }
            ranked = rankBetween(before ? spaced.get(before.frontmatter.id) : undefined, after ? spaced.get(after.frontmatter.id) : undefined);
        }

        if (!ranked.ok) {
            // renormalizedPositions spaces every neighbour POSITION_GAP apart, which rankBetween
            // always finds room in — unreachable, not a real case to recover from.
            throw new Error(`could not rank ${id} between its neighbours even after renormalising "parking-lot"`);
        }

        await this.boardRepository.setPosition(id, ranked.position);
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
     * Rename a card's title. Not `writeWithEvent`: a rename edits stored content, exactly as `edit`
     * above edits `body` — it does not transition the card, which is the same reasoning
     * `BoardWriteService.depend`'s doc comment already records for editing `dependsOn`.
     *
     * Refuses a rename that would strand committed work. `WorktreeManager.branchName` slugs a card's
     * *title* into its branch name, and `StageDispatcher.resolveBranch` only prefers a *recorded*
     * `frontmatter.branch` once one exists (card 0095) — for a card no stage has dispatched yet,
     * `branchName(id, currentTitle)` is still what the next dispatch would cut or resume. Renaming
     * such a card before it is ever dispatched is free; renaming one whose current-title branch
     * already carries commits would leave the next dispatch resuming a branch that no longer matches
     * what the title now says, or (for `implementing`, which cuts with `-B`) silently discarding that
     * work outright. This does not rename the branch or persist `frontmatter.branch` itself — that is
     * a separate, bigger card (see board.ck's comment on this operation) — it only refuses the
     * dangerous case.
     */
    async rename(id: string, request: RenameCardRequest): Promise<CardDetail> {
        const before = await this.readOrThrow(id);
        const title = request.title.trim();

        if (title === before.frontmatter.title) {
            return toCardDetail(before);
        }
        if (title.length === 0) {
            throw httpError(400).withDetails({ reason: `cannot rename ${id}: a title cannot be empty` });
        }

        const branch = this.worktrees.branchName(id, before.frontmatter.title);
        if (await this.worktrees.hasWork(branch)) {
            throw httpError(400).withDetails({
                reason: `cannot rename ${id}: it has work on ${branch} — renaming would strand it`,
            });
        }

        await this.boardRepository.write(id, `Rename ${id}: "${before.frontmatter.title}" → "${title}"`, card => ({
            ...card,
            frontmatter: { ...card.frontmatter, title },
        }));

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
     * Approve a card's plan: pin its current version and move it from `planning` into `backlog`.
     *
     * Card 0127 reconciled this. `approve` used to move `backlog` → `backlog`'s `onPass` and pin on
     * the way out; now entering `backlog` is what pins (see {@link move}'s doc comment), from
     * whichever stage a card reaches it from — `planning`, `parking-lot`, or a `scope-check`
     * refusal routed back through `planning`. Keeping two ways to approve (this method's old
     * behaviour alongside the new gate) is exactly the drift the card called out, so this is not
     * retired — `POST /api/cards/:id/approve` is generated from the board contract, outside this
     * card's "Files in scope", and `board.router.ts` still calls `service.approve(id)` by that name
     * — it is repointed: `wilson card approve` is now the name for the everyday `planning` →
     * `backlog` move, a thin `planning`-only front door onto `move`, which does the actual pinning
     * and empty-scope refusal. A `parking-lot` → `backlog` promotion, which is not "approving a
     * plan" in the same sense, goes through plain `wilson card move` instead, as it already did.
     */
    async approve(id: string): Promise<CardDetail> {
        const card = await this.readOrThrow(id);
        if (card.frontmatter.stage !== 'planning') {
            throw httpError(400).withDetails({ reason: `cannot approve ${id}: it is in "${card.frontmatter.stage}", not "planning"` });
        }

        return this.move(id, { stage: 'backlog' });
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
     *
     * Card 0264: refuses before any of that, naming both figures, once this project has spent its
     * `daily-output-token-ceiling` for the day — the same refusal shape (`httpError(400)`, a `reason`
     * in `details`) every other guard below already throws, so this reads as one more of them rather
     * than a different kind of failure. `Poller.tickProject` checks the identical setting the same
     * way before it ever enqueues on its own, so a project at its ceiling refuses this the same way
     * whether a human or the poller is asking.
     */
    async start(id: string): Promise<CardDetail> {
        const card = await this.readOrThrow(id);

        const ceiling = await this.settings.get(DAILY_OUTPUT_TOKEN_CEILING);
        if (ceiling > 0) {
            const spent = await this.eventLog.outputTokensSince(this.boardConfig.project, DateTime.now().startOf('day'));
            if (spent >= ceiling) {
                throw httpError(400).withDetails({
                    reason: `cannot enqueue ${id}: ${this.boardConfig.project} has spent ${spent} output tokens today, at or over its daily ceiling of ${ceiling}`,
                });
            }
        }

        const stages = await this.stageConfigs.load();
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
        // mid-run on *this* card right now (see its doc in running.cards.ts — the same tracker
        // `stopCardStageJobs` reads to report shutdown abandonment). A claim `inFlight` still calls
        // live but that this process is not currently running is exactly a claim left behind by an
        // earlier process that crashed before it could clear or hand off — safe to release.
        //
        // Card 0149: `RunningCards` entries are keyed by `(project, cardId)`, not `cardId` alone —
        // this route stays single-project (out of scope for this card), so `this.boardConfig.project`
        // is always the one project it serves, and the check must not match another registered
        // project's own `id`-numbered card running in the same process.
        if (this.runningCards.snapshot().some(entry => entry.project === this.boardConfig.project && entry.cardId === id)) {
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

    /**
     * Card 0143, rehearsable as of card 0144. Merge a card's branch into `main` — the step every
     * card on this board has always needed a human with a shell for: verify clean, `git merge
     * --no-ff`, run the suite, `wilson card move <id> merged`. This is that, minus the shell: no
     * checkout of `codeRoot` ([[0025]]'s warning, card 0143's own Constraints), and the card does
     * not move until the ref move is verified, not merely reported.
     *
     * With dry run on (`DRY_RUN_ENABLED`, the default — PROJECT.md's *Safety* section), the target
     * is {@link WorktreeManager.ensureIntegrationBranch}'s branch instead of `main`: the merge, the
     * suite proof, and the land all run exactly as they would against `main`, but `main` itself is
     * never read with anything that could move it and its sha is asserted unchanged before this
     * returns. The card still ends in `merged` — withholding that would make every card depending on
     * this one permanently undispatchable, defeating a rehearsal's whole purpose (this card's
     * Constraints) — and `MergeResult.reason` says plainly that it was a rehearsal, on the same field
     * a real merge leaves empty.
     *
     * Only "this card is not in `ready`" is refused outright. A conflict and a suite failure are not
     * bad input — they are the other two honest outcomes an attempt can have — so both come back as
     * `{ merged: false, reason }` in a 200, exactly as `MergeResult`'s doc comment in the contract
     * says, and both flag the card for a human the same way [[0103]]'s rebase-conflict handling does:
     * `needsHuman` set, the card left exactly where it was, no retry touched (`ready` is a `manual`
     * stage; nothing here is a kickback to consume one from).
     *
     * Card 0238: before any of that, when {@link RE_REVIEW_ON_MERGE} is on, checks whether `main`
     * moved under files the card itself changed since the card's review ran
     * ({@link WorktreeManager.overlapSinceFork} — review is the last stage before `ready`, so its
     * merge-base against `targetRef` is exactly the commit review saw). A nobody-has-read-the-
     * combined-diff overlap sends the card back to `review` (see {@link reReviewOnOverlap}) rather
     * than proceeding to `computeMerge` — the dispatcher rebases on re-entry, so the reviewer reads
     * the card's diff over whatever merged since. A human rebasing the branch by hand after review
     * moves the merge-base and skips this check; that gap is accepted, not fixed here.
     */
    async merge(id: string): Promise<MergeResult> {
        const card = await this.readOrThrow(id);
        if (card.frontmatter.stage !== 'ready') {
            throw httpError(400).withDetails({ reason: `cannot merge ${id}: it is in "${card.frontmatter.stage}", not "ready"` });
        }

        const dryRun = await this.settings.get(DRY_RUN_ENABLED);
        const targetRef = dryRun ? await this.worktrees.ensureIntegrationBranch() : 'main';
        // Read before anything below runs, so a dry run can prove afterward that nothing it did
        // moved `main` — the whole value of a rehearsal is that it cannot touch the thing it
        // rehearses (this card's Constraints). `headSha` reads `codeRoot`'s HEAD, which is `main`
        // whether or not this run is a dry run, so this is a real assertion, not a tautology.
        const mainShaBefore = dryRun ? await this.worktrees.headSha() : undefined;

        const branch = this.worktrees.resolveBranch(card);

        const reReviewOnMerge = await this.settings.get(RE_REVIEW_ON_MERGE);
        if (reReviewOnMerge) {
            const overlap = await this.worktrees.overlapSinceFork(branch, targetRef);
            if (overlap.movedUnder.length > 0) {
                return this.reReviewOnOverlap(id, card, overlap.movedUnder);
            }
        }

        const computed = await this.worktrees.computeMerge(branch, targetRef);
        if (!computed.ok) {
            const reason = `${branch} conflicts with ${targetRef}: ${computed.conflicts.length > 0 ? computed.conflicts.join(', ') : computed.raw.slice(0, 2000)}`;
            await this.flagMergeFailure(id, card.frontmatter.stage, reason);
            return { ...toCardDetail(await this.boardRepository.read(id)), merged: false, reason };
        }

        const message = dryRun
            ? `Merge card ${id}: ${card.frontmatter.title} (dry run — rehearsed onto ${targetRef}, main withheld)`
            : `Merge card ${id}: ${card.frontmatter.title}`;
        const mergeCommit = await this.worktrees.commitMerge(computed.targetSha, computed.branchSha, computed.treeSha, message);

        const proof = await this.proveMerge(id, mergeCommit);
        if (!proof.ok) {
            const reason = `merge of ${branch} into ${targetRef} fails the suite: ${proof.reason}`;
            await this.flagMergeFailure(id, card.frontmatter.stage, reason);
            return { ...toCardDetail(await this.boardRepository.read(id)), merged: false, reason };
        }

        const landed = await this.worktrees.landMerge(computed.targetSha, mergeCommit, targetRef);
        if (!landed.ok) {
            await this.flagMergeFailure(id, card.frontmatter.stage, landed.reason);
            return { ...toCardDetail(await this.boardRepository.read(id)), merged: false, reason: landed.reason };
        }

        if (dryRun) {
            const mainShaAfter = await this.worktrees.headSha();
            if (mainShaAfter !== mainShaBefore) {
                // Not a recoverable outcome for this attempt — landing already happened, and a dry
                // run that moved `main` is exactly the failure this card exists to make impossible.
                // Surfacing it as a thrown 500 rather than a quiet `merged: false` is deliberate:
                // this is a bug in the rehearsal itself, not an honest outcome of one.
                throw new Error(
                    `dry-run merge of ${id} landed on ${targetRef}, but main moved from ${mainShaBefore} to ${mainShaAfter} — a rehearsal must never touch main`,
                );
            }
        }

        // The existing write path, not a bespoke one: `move` is what pins runner state to a
        // transition, reclaims the worktree on a terminal target, and clears a stale flag — every
        // reason `[[0143]]`'s Constraints give for landing through the same door every other
        // terminal transition uses. This runs even in dry run: a dry-run merge is what lets a
        // dependent card dispatch (this card's Constraints), so the card reaching `merged` cannot
        // wait for dry run to be turned off.
        await this.move(id, { stage: 'merged' });

        const reason = dryRun ? `dry run: rehearsed onto ${targetRef} at ${mergeCommit.slice(0, 8)} — the write to main was withheld` : undefined;
        return { ...toCardDetail(await this.boardRepository.read(id)), merged: true, commit: mergeCommit, reason };
    }

    /**
     * Flag a card for a human without moving it or touching a retry — [[0103]]'s shape
     * (`flagRebaseConflict`, `modules/jobs/flag.rebase.conflict.ts`) reproduced here rather than
     * imported: that function takes a `RebaseConflictError`, which a merge conflict or a failed
     * suite is not, and `writeWithEvent`ing the same two fields directly is the smaller cost. `from`
     * and `to` both name the card's current stage because this never moves it — `ready` is exactly
     * where a human decides what happens next.
     */
    private async flagMergeFailure(id: string, stage: string, reason: string): Promise<void> {
        await this.boardRepository.writeWithEvent(
            id,
            `Flag ${id}: merge failed`,
            current => ({ ...current, frontmatter: { ...current.frontmatter, needsHuman: true, needsHumanReason: reason } }),
            {
                project: this.boardConfig.project,
                cardId: id,
                stage,
                type: 'transition.written',
                payload: { from: stage, to: stage, by: 'human', needsHuman: true, reason },
            },
        );
    }

    /**
     * Card 0238. Send a card back to `review` because `main` moved under files it changed since its
     * review ran, or — once that has happened {@link RE_REVIEW_CAP} times already — give up and flag
     * it for a human instead, the same bounded shape `kickback.ts`'s `droppedRetryKey` pattern gives
     * a stage's own retry counting: `retries['review:re-review']` is spent by *this* check alone,
     * never by review's own `maxKickbacks` counter, so a card that needed two genuine review cycles
     * before ever reaching `ready` still gets its full re-review allowance here.
     *
     * Not `move`: `move` records `by: 'human'`, clears `needsHuman`, and carries no `reason` field —
     * none of which is true of a send-back the runner itself decided on. `writeWithEvent` directly,
     * the same door {@link flagMergeFailure} already uses for a runner-authored transition that is
     * not an ordinary kickback either.
     */
    private async reReviewOnOverlap(id: string, card: Card, movedUnder: string[]): Promise<MergeResult> {
        const paths = movedUnder.join(', ');
        const attempted = card.frontmatter.retries[RE_REVIEW_RETRY_KEY] ?? 0;

        if (attempted >= RE_REVIEW_CAP) {
            const reason = `re-review: main moved under ${paths} since review, reaching its re-review cap of ${RE_REVIEW_CAP} — a human must ack and merge`;
            await this.flagMergeFailure(id, card.frontmatter.stage, reason);
            return { ...toCardDetail(await this.boardRepository.read(id)), merged: false, reason };
        }

        const round = attempted + 1;
        const reason = `re-review: main moved under ${paths} since review (round ${round} of ${RE_REVIEW_CAP})`;
        const retries = { ...card.frontmatter.retries, [RE_REVIEW_RETRY_KEY]: round };

        await this.boardRepository.writeWithEvent(
            id,
            `Send ${id} back to review: main moved under its files`,
            stored => ({ ...stored, frontmatter: { ...stored.frontmatter, stage: 'review', retries } }),
            {
                project: this.boardConfig.project,
                cardId: id,
                stage: 'review',
                type: 'transition.written',
                payload: { from: 'ready', to: 'review', by: 'runner', reason },
            },
        );

        return { ...toCardDetail(await this.boardRepository.read(id)), merged: false, reason };
    }

    /**
     * Card 0143. Prove the computed merge before it lands: cut a throwaway worktree at
     * `mergeCommit` — unreferenced by any branch until {@link WorktreeManager.landMerge} says so —
     * and run the `testing` stage's own configured suite against it, the same command the testing
     * stage already treats as "green". Both the worktree and its throwaway branch are reclaimed
     * unconditionally, pass or fail, so neither lingers the way the card's own worktree and branch
     * (left alone throughout this method — see Constraints) must: {@link PlanService.close} deletes
     * its own throwaway branch the same way after reclaiming that session's worktree.
     */
    private async proveMerge(id: string, mergeCommit: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        const stages = await this.stageConfigs.load();
        const stage = findStage(stages, 'testing');

        const scratchId = `${id}-merge-check`;
        const scratchBranch = `card/${id}-merge-check`;
        const worktree = await this.worktrees.create(scratchId, scratchBranch, mergeCommit);

        try {
            if (stage.setupCommand) {
                const setupCommand = stage.setupCommand;
                const setup = await pnpmStoreLock.run(
                    `${id} merge-check setup`,
                    message => this.logger.info(message),
                    () => runConfiguredCommand(worktree.path, setupCommand),
                );
                if (setup) return { ok: false, reason: `setup failed: ${setup.reason}` };
            }

            if (!stage.testCommand) return { ok: false, reason: 'no testCommand configured: the suite could not be proven' };

            const run = await runConfiguredCommand(worktree.path, stage.testCommand);
            if (!run) return { ok: true };

            return await this.judgeFailedMergeSuite(id, worktree.path, stage, run);
        } finally {
            await this.worktrees.reclaim(scratchId);
            await git(this.boardConfig.codeRoot, ['branch', '-D', scratchBranch]).catch(() => undefined);
        }
    }

    /**
     * Card 0261. The same one-rerun rule `TestingVerifier.judgeRedRun` applies to the testing stage
     * itself, applied here before a merge-check failure is believed — for the reason the card's Goal
     * names: on 2026-09-19, cards 0250 and 0253 each failed their merge check on
     * `project-switcher.test.ts`, which then passed 3 of 3 runs alone on the same merge commit,
     * costing a human each time. `stage.testReportPath` is read the same way
     * `TestingVerifier.readReport` reads it, but a missing or unusable report is not pushed as a
     * fault here — it just means there is nothing to rerun, exactly like a report that parsed
     * cleanly but named no failures.
     *
     * No named failures means the run is judged red exactly as it always has been (`run.reason`,
     * unchanged). A rerun of just the failing files that comes back red too is judged red the same
     * way, with `run`'s own reason, not the rerun's — this was not a flake. A rerun that comes back
     * green appends a `test.flaky` event naming the tests and lets the merge proceed, `run:
     * 'merge-check'` distinguishing it in the card's history from a `test.flaky` event
     * `TestingVerifier` itself might have appended.
     */
    private async judgeFailedMergeSuite(
        id: string,
        worktreePath: string,
        stage: StageConfig,
        run: CommandFailure,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
        const report = await this.readTestReport(worktreePath, stage.testReportPath);
        const failing = report?.failing ?? [];
        if (failing.length === 0 || !stage.testCommand) return { ok: false, reason: run.reason };

        const files = [...new Set(failing.map(test => test.file))];
        const rerun = await runConfiguredCommand(worktreePath, `${stage.testCommand} ${files.join(' ')}`);
        if (rerun) return { ok: false, reason: run.reason };

        await this.eventLog.append({
            project: this.boardConfig.project,
            cardId: id,
            // `proveMerge` only ever runs against a card in `ready` (`merge`'s own guard, above) —
            // named literally rather than threaded through as a parameter for a value that can only
            // ever be this one.
            stage: 'ready',
            type: 'test.flaky',
            payload: { tests: failing.map(describeFailingTest), run: 'merge-check' },
        });
        return { ok: true };
    }

    /**
     * Card 0261. Read the test report `proveMerge`'s run just wrote, mirroring
     * `TestingVerifier.readReport` but with no `failures` array to push onto: an absent
     * `testReportPath`, an unreadable file, or one that fails to parse are all read the same way —
     * as "nothing to rerun" — rather than as a fault this method reports itself.
     * `judgeFailedMergeSuite` already has the real failure to fall back to (`run.reason`) when that
     * happens.
     */
    private async readTestReport(worktreePath: string, testReportPath: string | undefined) {
        if (!testReportPath) return undefined;
        const raw = await readFile(join(worktreePath, testReportPath), 'utf8').catch(() => undefined);
        if (raw === undefined) return undefined;
        try {
            return parseTestReport(raw, worktreePath);
        } catch {
            return undefined;
        }
    }

    /**
     * The most recent scope-check refusal on record for a card, read from its event log rather than
     * a fresh run: `scope-check` already happened, and re-running it (card 0105's job, not this
     * one's) could return a different division for the cost of a whole pass. Writes nothing —
     * {@link split} below is the only thing in this pair that does.
     *
     * Refuses, naming why, when there is nothing to act on: no `stage.failed` event on record for
     * `scope-check`, or one whose `result` did not survive re-parsing as a `ScopeCheckResult` (a
     * schema mismatch old data could carry, or a result that was never structured to begin with) or
     * whose `division` came back empty. Both read as "nothing to split" rather than a 500, since a
     * client cannot act on either.
     */
    async division(id: string): Promise<CardDivision> {
        await this.readOrThrow(id);

        const rows = await this.eventLog.tail(this.boardConfig.project, id, DIVISION_LOOKBACK);
        let refusal: (typeof rows)[number] | undefined;
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i]!.type === 'stage.failed' && rows[i]!.stage === 'scope-check') {
                refusal = rows[i];
                break;
            }
        }
        if (!refusal) {
            throw httpError(400).withDetails({ reason: `${id} has no scope-check refusal on record — nothing to split` });
        }

        const parsed = ScopeCheckResultSchema.safeParse((refusal.payload as { result?: unknown }).result);
        if (!parsed.success || parsed.data.division.length === 0) {
            throw httpError(400).withDetails({ reason: `${id}'s most recent scope-check refusal carried no division — nothing to split` });
        }

        return {
            reason: parsed.data.reason,
            pieces: parsed.data.division.map(piece => ({
                title: piece.title,
                tasks: piece.tasks,
                delivers: piece.delivers,
                dependsOn: piece.dependsOn,
            })),
        };
    }

    /**
     * Create one card per confirmed piece, in `planning` — never `backlog`, since a piece is a title,
     * a task list and a sentence, not a plan with all six headings filled in (`wilson card plan` is
     * how it gets one) — record the dependencies named in each piece's `dependsOn`, and annotate the
     * origin card with the ids it produced.
     *
     * Never moves or drops the origin (card [[0090]]'s stranding lesson applies here too, and the
     * pieces are exactly what would be stranded), and never re-runs `scope-check` on what it creates
     * — deciding a split is `scope-check`'s job (card 0105); this only acts on pieces an operator
     * already confirmed, which is the whole of `request.pieces` rather than anything re-read from the
     * event log.
     *
     * Cards are created one at a time, each computing the next id over the board it just extended —
     * the same sequential assignment {@link create} uses, applied in a loop because this creates more
     * than one. Dependencies are recorded in a second pass, once every piece has an id, so a piece
     * naming a dependency that sorts after it in `request.pieces` is not left unresolved.
     *
     * **Why this does not call {@link create} and {@link depend}, which card 0113's plan asked for.**
     * Both would work and both would lose the version message. `create` writes its own, and neither
     * takes one, so every piece's history would read as an ordinary card creation with nothing tying
     * it to the card it came out of — where this writes `Split 0111 into 0114: <piece title>`, and
     * the dependency pass writes which piece it was recorded for. On a card whose whole purpose is
     * provenance, that link is the part worth keeping, and the duplication is four lines.
     *
     * The maintenance risk is real and stated rather than hidden: behaviour added to `create` or
     * `depend` does not reach here. If a third caller ever needs the same thing, give those two an
     * optional message and collapse this into them — that is the fix, not copying more of them.
     *
     * Validation runs before anything is written, unlike the piecemeal failures reusing `depend`
     * would give: at least two pieces, unique titles, no piece depending on itself, and every
     * `dependsOn` naming a piece in this same request. A split that cannot be completed writes no
     * cards at all.
     */
    async split(id: string, request: SplitCardsRequest): Promise<SplitResult> {
        const origin = await this.readOrThrow(id);

        if (request.pieces.length < 2) {
            throw httpError(400).withDetails({ reason: 'a split needs at least two pieces' });
        }

        const titles = new Set(request.pieces.map(piece => piece.title));
        if (titles.size !== request.pieces.length) {
            throw httpError(400).withDetails({ reason: 'piece titles must be unique' });
        }
        for (const piece of request.pieces) {
            for (const dep of piece.dependsOn) {
                if (dep === piece.title) {
                    throw httpError(400).withDetails({ reason: `piece "${piece.title}" lists itself as a dependency` });
                }
                if (!titles.has(dep)) {
                    throw httpError(400).withDetails({
                        reason: `piece "${piece.title}" depends on "${dep}", which is not one of the pieces being created`,
                    });
                }
            }
        }

        const titleToId = new Map<string, string>();
        for (const piece of request.pieces) {
            const cardId = nextCardId(await this.boardRepository.list());
            const card: Card = {
                frontmatter: { id: cardId, title: piece.title, stage: 'planning', dependsOn: [], retries: {} },
                sections: {},
                body: seedSplitBody(id, origin.frontmatter.title, piece),
            };
            await this.boardRepository.create(card, `Split ${id} into ${cardId}: ${piece.title}`);
            titleToId.set(piece.title, cardId);
        }

        for (const piece of request.pieces) {
            const cardId = titleToId.get(piece.title)!;
            for (const depTitle of piece.dependsOn) {
                const dependsOnId = titleToId.get(depTitle)!;
                await this.boardRepository.write(cardId, `Add ${cardId} dependency on ${dependsOnId}`, card => ({
                    ...card,
                    frontmatter: { ...card.frontmatter, dependsOn: [...card.frontmatter.dependsOn, dependsOnId].sort() },
                }));
            }
        }

        const producedIds = request.pieces.map(piece => titleToId.get(piece.title)!);
        await this.boardRepository.write(id, `Split ${id} into ${producedIds.join(', ')}`, card => ({
            ...card,
            body: `${card.body}\n\n---\n\nSplit into: ${producedIds.join(', ')}. This card was left in place — drop it yourself once the pieces above are planned.`,
        }));

        const pieces = await Promise.all(producedIds.map(cardId => this.boardRepository.read(cardId).then(toCardDetail)));

        return {
            origin: toCardDetail(await this.boardRepository.read(id)),
            pieces,
        };
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
 * The note {@link BoardWriteService.recordFindings} passes to `withFindings` — the one line that
 * tells implementing this `## Review findings` section came from a person reading the diff, not
 * from `review`'s own agent, since the bullets underneath read identically either way.
 */
const HUMAN_FINDINGS_NOTE = '_A human left these comments on the diff._';

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

/**
 * How far back {@link BoardWriteService.division} scans a card's event log for its most recent
 * scope-check refusal. `EventLog.tail` has no type/stage-filtered query — `event.log.ts` is outside
 * this card's "Files in scope" — so this is the same best-effort lookback cap
 * `BoardRepository.grantedPaths` already accepts for `scope.granted` events, applied here to
 * `stage.failed`/`scope-check` instead: generous rather than exact, and wrong only for a card whose
 * event history runs past it before the refusal it should find.
 */
const DIVISION_LOOKBACK = 2000;

/**
 * The `retries` key {@link BoardWriteService.reReviewOnOverlap} counts its send-backs under —
 * distinct from `review`, the stage name itself, so this check's bookkeeping never touches
 * `review`'s own `maxKickbacks` counter. Follows `kickback.ts`'s `droppedRetryKey` naming: `<the
 * stage it routes to>:<what this counter is>`.
 */
const RE_REVIEW_RETRY_KEY = 'review:re-review';

/**
 * How many times {@link BoardWriteService.reReviewOnOverlap} sends a card back to `review` for the
 * same reason before giving up and flagging a human. Small and fixed, the same posture
 * `RESULT_DROPPED_ALLOWANCE` (`kickback.ts`) takes for its own bounded allowance: a card whose
 * files keep colliding with what lands on `main` is not making progress by retrying forever.
 */
const RE_REVIEW_CAP = 2;

/**
 * A stub body for a card created from one division piece: what it would deliver, the tasks it
 * carries, and a pointer back to the card it was cut from. Not the six-heading plan contract —
 * `PLAN_SECTIONS` is what `backlog` requires, and this card lands in `planning`, unplanned, on
 * purpose (see {@link BoardWriteService.split}'s doc comment).
 */
const seedSplitBody = (originId: string, originTitle: string, piece: { tasks: string[]; delivers: string }): string =>
    [
        `Split from ${originId} (${originTitle}), one piece of a scope-check refusal's division. Not yet planned — run \`wilson card plan\` next.`,
        '',
        '## Delivers',
        '',
        piece.delivers,
        '',
        '## Tasks',
        '',
        ...piece.tasks.map(task => `- ${task}`),
    ].join('\n');
