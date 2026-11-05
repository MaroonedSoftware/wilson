import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Logger } from '@maroonedsoftware/logger';
import { collateralPaths } from '#modules/agent/collateral.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import { serializeCard } from '#modules/board/card.parser.js';
import { filesInScope, type Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import type { LearningsStore } from '#modules/learnings/learnings.store.js';
import { worktreeHost, type Worktree, type WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { pnpmStoreLock, runConfiguredCommand } from './run.command.js';
import type { ProjectStages, StageConfig } from './stage.config.js';

/** What preparing a stage's tree needs, whoever is asking: a card's dispatch or an eval. */
export interface StagePreparationDeps {
    config: BoardConfig;
    worktrees: Pick<WorktreeManager, 'failedAttemptPatchPath'>;
    events: EventLog;
    logger: Logger;
    learnings?: Pick<LearningsStore, 'load'>;
}

export interface StagePreparationInput {
    cardId: string;
    stageName: string;
    stages: ProjectStages;
    stage: StageConfig;
    /** The plan contract: the card at its pinned version. */
    card: Card;
    pinnedSha: string | undefined;
    worktree: Worktree;
    placement?: RemotePlacement;
    port?: number;
    /** The cards whose preserved patches this stage may read. */
    boardCards: Card[];
}

/** A tree ready for its agent: where the plan and learnings are, and what the agent may write. */
export interface PreparedStage {
    planPath: string;
    learningsPath?: string;
    scoped: string[];
    scope: ScopeGuard;
}

/**
 * The `extraScope` the running stage may itself write, beyond this card's own "Files in scope" —
 * the fact `materializePlan` folds into that stage's own plan so it knows what it can already
 * write, instead of calling `request_scope` for paths `ScopeGuard`'s allow list (`scoped` in `run`,
 * above) already covers.
 *
 * `ScopeGuard` is built from `[...filesInScope(card), ...stage.extraScope]`, but that allow list
 * lives inside the guard — nothing the agent reads ever names it. A plan that lists only the card's
 * own "Files in scope" and says nothing about `extraScope` reads as "everything else is out of
 * bounds," which is exactly what led card 0154's testing stage to request and be granted four test
 * files its own `*.test.ts` glob already allowed.
 *
 * Deliberately a separate note from `otherStagesScopeNote`, not folded into one list: that one tells
 * a reviewer "a file here is another stage doing its job"; this one tells the running stage "you may
 * write these yourself." Merging them would leave a reader guessing which sense applied to which
 * line.
 *
 * Returns the empty string when this stage configures no `extraScope`, so a stage with none gets no
 * heading and no dangling sentence, matching `otherStagesScopeNote`.
 */
const ownScopeNote = (stage: StageConfig): string => {
    if (stage.extraScope.length === 0) return '';

    return [
        '## Your scope',
        '',
        'Beyond this card\'s own "Files in scope" above, this stage may also write, under its own',
        'configured scope:',
        '',
        ...stage.extraScope.map(g => `- \`${g}\``),
    ].join('\n');
};

/**
 * The paths another stage may add on top of this card's own "Files in scope" — the fact
 * `materializePlan` folds into every stage's plan so a file a later stage legitimately adds under
 * its own `extraScope` (`stage.config.ts`) reads as expected, not as undeclared scope creep.
 *
 * A card's "Files in scope" is written for `implementing`; nothing else about the pipeline is in
 * that document, so a stage reading only the plan has no way to tell a test file the testing stage
 * added under its own `extraScope` apart from one that was never declared at all (card 0139).
 *
 * Generated from the loaded `stages.yaml`, not duplicated here as a second copy of it: a project
 * that configures different globs, or a different stage entirely, gets those globs with no code
 * change. Excludes the stage this plan is being materialized for — not because restating it would
 * say nothing new (`ScopeGuard`'s allow list enforces that stage's own `extraScope` but never shows
 * it to the agent, which is exactly why `ownScopeNote`, above, exists), but because it is a different
 * fact for a different reader: this list tells a reviewer "a file here is that stage doing its job,"
 * not "you may write this." Returns the empty string when no other stage configures one, so a project
 * with no `extraScope` anywhere gets no heading and no dangling sentence.
 */
const otherStagesScopeNote = (stages: ProjectStages, currentStageName: string): string => {
    const others = stages.stages.filter(s => s.name !== currentStageName && s.extraScope.length > 0);
    if (others.length === 0) return '';

    return [
        '## Also in scope',
        '',
        'Not this card\'s own "Files in scope" above, but paths another stage may add under its own',
        'configured scope. A file here in the diff is that stage doing its job, not undeclared scope',
        'creep:',
        '',
        ...others.map(s => `- \`${s.name}\`: ${s.extraScope.map(g => `\`${g}\``).join(', ')}`),
    ].join('\n');
};

/**
 * Write the plan where the agent can read it — outside the worktree.
 *
 * The board is a sibling repo, so the plan is not in the tree the agent is editing. Materializing
 * it outside means it can never be accidentally committed to the card's branch.
 *
 * Appends `ownScopeNote` and `otherStagesScopeNote` after the card's own body — the one place
 * every stage's agent, review included, actually reads (card 0139). `stages` is the same config
 * `run` already loaded for this dispatch, not a second load.
 */
const materializePlan = async (
    deps: StagePreparationDeps,
    card: Card,
    sha: string | undefined,
    stages: ProjectStages,
    stage: StageConfig,
): Promise<string> => {
    const dir = join(deps.config.runRoot, 'cards', card.frontmatter.id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'plan.md');
    const notes = [ownScopeNote(stage), otherStagesScopeNote(stages, stage.name)].filter(note => note.length > 0);
    const material = notes.length > 0 ? `${serializeCard(card).trimEnd()}\n\n${notes.join('\n\n')}\n` : serializeCard(card);
    await writeFile(path, material, 'utf8');
    deps.logger.info(`plan for ${card.frontmatter.id} materialized at ${path}${sha ? ` (${sha.slice(0, 8)})` : ''}`);
    return path;
};

/**
 * Write the project's learnings document where the agent can read it — outside the worktree,
 * for the identical reason `materializePlan` above lives there: so it can never be committed to
 * the card's branch. Called only when `run` already knows the document is non-empty, so unlike
 * `materializePlan` this has no "absent" case of its own to handle.
 */
const materializeLearnings = async (deps: StagePreparationDeps, cardId: string, markdown: string): Promise<string> => {
    const dir = join(deps.config.runRoot, 'cards', cardId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'learnings.md');
    await writeFile(path, markdown, 'utf8');
    return path;
};

/**
 * Copy a file materialized here to the same card's folder under the host's run root.
 *
 * `rehome` rewrites this machine's run root to the host's wherever it appears in the text: a
 * plan names preserved patches by path (its attempts section records each failed attempt's
 * `patchPath`, and a split card's plan cites its parent's), and on the host those paths are the
 * copies `mirrorPatches` makes, not the originals.
 */
const mirrorToHost = async (
    deps: StagePreparationDeps,
    placement: RemotePlacement,
    cardId: string,
    localPath: string,
    rehome = false,
): Promise<string> => {
    const dir = posix.join(placement.runRoot, 'cards', cardId);
    const remotePath = posix.join(dir, posix.basename(localPath));
    const text = await readFile(localPath, 'utf8');
    await placement.host.mkdir(dir);
    await placement.host.writeFile(
        remotePath,
        rehome ? text.replaceAll(`${join(deps.config.runRoot, 'cards')}/`, `${posix.join(placement.runRoot, 'cards')}/`) : text,
    );
    return remotePath;
};

/** Every board card's preserved patch that exists here, copied to the host; the copies' paths. */
const mirrorPatches = async (deps: StagePreparationDeps, placement: RemotePlacement, boardCards: Card[]): Promise<string[]> => {
    const copied: string[] = [];
    for (const board of boardCards) {
        const local = deps.worktrees.failedAttemptPatchPath(board.frontmatter.id);
        const exists = await stat(local).then(
            () => true,
            () => false,
        );
        if (exists) copied.push(await mirrorToHost(deps, placement, board.frontmatter.id, local));
    }
    return copied;
};

/**
 * Make a cut worktree ready for its agent: run the setup command, write the plan and learnings where
 * the agent can read them, and build the guard that says what it may touch. Nothing here reaches the
 * board, so a card's dispatch and an eval prepare a tree identically. Throws when setup fails.
 */
export const prepareStage = async (deps: StagePreparationDeps, input: StagePreparationInput): Promise<PreparedStage> => {
    const { cardId, stageName, stages, stage, card, pinnedSha, worktree, placement, port, boardCards } = input;

    // Before the agent sees the tree, not as its first task: a fresh worktree has no
    // node_modules, and card 0001 twice spent its whole run installing dependencies and
    // confirming the baseline built, then reported that as the work.
    //
    // Wrapped in `pnpmStoreLock` because this is an install: two of these racing pnpm's shared
    // store is what broke four of five cards started together in card 0081, and an agent's own
    // `pnpm install` through the bash tool takes the same lock, so either side waits for the
    // other rather than corrupting the store. The wait happens here, before `runAgent` below
    // ever starts the stage's `maxWallClockMs` clock — that clock opens inside the adapter's own
    // `generate()` call (`api.stage.agent.ts`/`cli.stage.agent.ts`), well after this returns — so
    // a stage queued behind another card's install is not charged for a queue it did not choose.
    if (stage.setupCommand) {
        const setupCommand = stage.setupCommand;
        // Captured alongside the log line `pnpmStoreLock` already emits, so a wait shows up in
        // the durable event trail too, not only in the log an operator has to be watching live —
        // the same reasoning `withCollateralCaveats` above applies to `scope.collateral`: a log
        // entry nobody reads before the review runs is not the same as recorded.
        let installWaitedMs: number | undefined;
        const failure = await pnpmStoreLock.run(
            `${cardId} ${stageName} setup`,
            message => deps.logger.info(message),
            () => runConfiguredCommand(worktree.path, setupCommand, undefined, port, worktreeHost(worktree)),
            waitedMs => {
                installWaitedMs = waitedMs;
            },
        );
        await deps.events.append({
            project: deps.config.project,
            cardId,
            stage: stageName,
            type: 'worktree.prepared',
            payload: {
                command: setupCommand,
                ok: !failure,
                ...(failure ? { reason: failure.reason } : {}),
                ...(installWaitedMs !== undefined ? { installWaitedMs } : {}),
            },
        });
        if (failure) {
            // Not retried: the race that used to produce this exact failure is gone now that the
            // install is serialized, so what reaches here is a genuine failure — a real lockfile
            // mismatch, a registry outage, a full disk — and retrying identical work against an
            // unpinned cause is exactly the waste `isPermanentFailure` exists to avoid elsewhere.
            // An unprepared worktree makes every later signal meaningless — the build would fail
            // for reasons that have nothing to do with the card.
            throw new Error(`worktree setup failed for ${cardId}: ${failure.reason}`);
        }
        deps.logger.info(`worktree prepared with \`${setupCommand}\``);
    }

    const localPlanPath = await materializePlan(deps, card, pinnedSha, stages, stage);
    // The agent reads the plan where its worktree is. A placed stage gets a copy on the host,
    // under the host's run root, outside its worktree for the same reason the local one is.
    const planPath = placement ? await mirrorToHost(deps, placement, cardId, localPlanPath, true) : localPlanPath;

    // Card 0244: the project's human-approved learnings document, materialized outside the
    // worktree the same way the plan is — so it can never be committed to the card's branch
    // either. Empty (`load()`'s own contract: no document yet reads the same as an empty one,
    // PROJECT.md decision 8) or `deps.learnings` altogether unset (see the constructor's own
    // comment) both mean no file is written and no path reaches the adapter at all — an empty
    // document means "no learnings", not an empty file to hand the agent.
    const learningsMarkdown = (await deps.learnings?.load()) ?? '';
    const localLearningsPath = learningsMarkdown.trim().length > 0 ? await materializeLearnings(deps, cardId, learningsMarkdown) : undefined;
    const learningsPath = placement && localLearningsPath ? await mirrorToHost(deps, placement, cardId, localLearningsPath) : localLearningsPath;

    // Structural dependencies of a scoped file, one hop out — so the stage does not have to ask
    // for the file defining a type it is already using because something in scope imports it.
    const scoped = [...filesInScope(card), ...stage.extraScope];
    const collateral = await collateralPaths(worktree.path, scoped, worktreeHost(worktree));

    // Every card's preserved patch, not just this one's (card 0161): a split card's plan
    // routinely names its parent's `last-failed-attempt.patch` as the single most useful
    // artifact around, and the stage running it has no way to know in advance which card that
    // will be — `boardCards`, already fetched above for `assertDispatchable`, is every card on
    // the board. Listed unconditionally, with no `stat` first: most cards have never failed, so
    // most of these paths do not exist, and an unconditional grant just lets that read fail with
    // an ordinary "no such file" — the same as any other in-scope path that happens to be
    // absent — rather than the scope refusal this card exists to remove.
    //
    // A placed stage gets the same set, copied to the same place under the host's run root.
    // Only the patches that exist are copied: whether one does is a local `stat`, and the
    // copies are what cost a round trip, so a board of cards that never failed costs nothing.
    const preservedPatchPaths = placement
        ? await mirrorPatches(deps, placement, boardCards)
        : boardCards.map(c => deps.worktrees.failedAttemptPatchPath(c.frontmatter.id));

    const scope = new ScopeGuard({
        worktreeRoot: worktree.path,
        allow: scoped,
        alwaysAllowed: stages.alwaysAllowed,
        deny: stages.deny,
        collateral,
        // The plan and every card's preserved patch live outside the worktree so neither can be
        // committed to the card's branch. Without this both are also unreadable, and the agent
        // either infers its own contract or is refused the one artifact its plan told it to read.
        // `learningsPath` joins them on the same footing, present only when the document is
        // non-empty — see its own comment above.
        readableExtras: [planPath, ...preservedPatchPaths, ...(learningsPath ? [learningsPath] : [])],
        host: worktreeHost(worktree),
    });

    return { planPath, learningsPath, scoped, scope };
};
