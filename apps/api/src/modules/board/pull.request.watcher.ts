import { setTimeout as delay } from 'node:timers/promises';
import { Injectable } from 'injectkit';
import { Duration } from 'luxon';
import { Logger } from '@maroonedsoftware/logger';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { BoardConfig } from './board.config.js';
import { BoardRepository } from './board.repository.js';
import { BoardWriteService } from './board.write.service.js';
import type { Card, CardPullRequest } from './card.js';
import { runAsProject } from './project.context.js';
import { ProjectRepository } from './project.repository.js';
import { PULL_REQUEST_BASE, PullRequestLander } from './pull.request.lander.js';

/**
 * How often open pull requests are asked after. GitHub cannot reach most deployments to say so
 * itself, and a merged pull request waiting two minutes for its card is no cost worth a setting.
 */
export const PULL_REQUEST_WATCH_INTERVAL = Duration.fromObject({ minutes: 2 });

/**
 * Follows the pull requests Merge opened (`BoardWriteService.mergeAsPullRequest`) until GitHub
 * settles them, for every registered project.
 *
 * Merged: GitHub's `main` is fetched and the clone's `main` fast-forwarded to it through
 * `WorktreeManager.landMerge` (compare-and-swap, checkout reconciled), and only then is the card
 * moved to `merged`, by the runner. That order is the point: `merged` is what lets a dependent card
 * dispatch, and its worktree is cut from the clone's `main`, so the card must not reach `merged`
 * before the clone holds its work. A clone whose `main` cannot fast-forward (it holds commits GitHub
 * does not) flags the card instead, with the pull request recorded as merged, for a person to bring
 * the clone up to date and move the card.
 *
 * Closed without merging: recorded as closed and the card flagged. Merge then opens a fresh one.
 *
 * Its own loop beside `Poller`, not part of its tick, because Auto-mode off must not stop a merged
 * pull request from reaching its card: the shape `StatusMirrorPoller` already has, a fixed interval
 * instead of a setting. One project's failure, or one card's, is logged and the walk goes on.
 */
@Injectable()
export class PullRequestWatcher {
    private abort: AbortController | undefined;
    private loopPromise: Promise<void> | undefined;

    constructor(
        private readonly board: BoardRepository,
        private readonly writes: BoardWriteService,
        private readonly lander: PullRequestLander,
        private readonly worktrees: WorktreeManager,
        private readonly config: BoardConfig,
        private readonly projects: ProjectRepository,
        private readonly logger: Logger,
    ) {}

    /** Idempotent: calling `start` while already running does nothing. */
    start(): void {
        if (this.abort) return;
        this.abort = new AbortController();
        this.loopPromise = this.loop(this.abort.signal);
    }

    /** Stop ticking and wait for the tick in flight, so nothing writes after shutdown. */
    async stop(): Promise<void> {
        this.abort?.abort();
        await this.loopPromise;
        this.abort = undefined;
        this.loopPromise = undefined;
    }

    private async loop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                await delay(PULL_REQUEST_WATCH_INTERVAL.toMillis(), undefined, { signal });
            } catch {
                return;
            }
            await this.tick();
        }
    }

    /** Every registered project in turn. Never throws. */
    async tick(): Promise<void> {
        let names: string[];
        try {
            const rows = await this.projects.list();
            for (const row of rows) this.config.register(row);
            names = rows.map(row => row.name);
        } catch (error) {
            this.logger.error(error);
            return;
        }
        for (const name of names) {
            try {
                await runAsProject(name, () => this.tickProject());
            } catch (error) {
                this.logger.error(error);
            }
        }
    }

    /** The current project's `ready` cards with an open pull request, each asked after once. */
    async tickProject(): Promise<void> {
        const waiting = (await this.board.list()).filter(
            card => card.frontmatter.stage === 'ready' && card.frontmatter.pullRequest?.state === 'open',
        );
        if (waiting.length === 0) return;

        const repository = await this.lander.repository();
        if (!repository) return;

        for (const card of waiting) {
            try {
                await this.follow(repository, card, card.frontmatter.pullRequest!);
            } catch (error) {
                this.logger.warn(`could not follow ${card.frontmatter.id}'s pull request: ${(error as Error).message}`);
            }
        }
    }

    private async follow(repository: string, card: Card, recorded: CardPullRequest): Promise<void> {
        const id = card.frontmatter.id;
        const pr = await this.lander.read(repository, recorded.number);
        if (pr.state === 'open') return;

        if (pr.state === 'closed') {
            const reason = `pull request #${recorded.number} was closed without merging; Merge opens a new one`;
            await this.flag(card, { ...recorded, state: 'closed' }, reason, {
                type: 'card.pull-request-closed',
                payload: { number: recorded.number, url: recorded.url },
            });
            return;
        }

        const merged: CardPullRequest = { ...recorded, state: 'merged' };
        const synced = await this.followMain(repository);
        if (!synced.ok) {
            const reason = `pull request #${recorded.number} merged on GitHub, but the clone's ${PULL_REQUEST_BASE} could not follow it: ${synced.reason}. Bring the clone up to date, then move the card to merged`;
            await this.flag(card, merged, reason);
            return;
        }

        await this.board.write(id, `Record pull request #${recorded.number} for ${id} as merged`, current => ({
            ...current,
            frontmatter: { ...current.frontmatter, pullRequest: merged },
        }));
        const at = pr.mergeCommitSha ? ` as ${pr.mergeCommitSha.slice(0, 8)}` : '';
        await this.writes.move(id, { stage: 'merged' }, { by: 'runner', reason: `pull request #${recorded.number} merged on GitHub${at}` });
        this.logger.info(`${id}: pull request #${recorded.number} merged; moved to merged`);
    }

    /**
     * Brings the clone's `main` to GitHub's: a fast-forward or nothing. A clone `main` already there
     * is fine, which is how a second card merged in the same tick finds it.
     */
    private async followMain(repository: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        const { sha } = await this.lander.fetchBase(repository);
        const local = await this.worktrees.shaOf(PULL_REQUEST_BASE);
        if (local === sha) return { ok: true };
        if (!(await this.worktrees.isAncestor(local, sha))) {
            return { ok: false, reason: `it holds commits GitHub's ${PULL_REQUEST_BASE} does not` };
        }
        return this.worktrees.landMerge(local, sha, PULL_REQUEST_BASE);
    }

    /**
     * Records `pullRequest` and flags the card for a person, leaving it in `ready`, in one write with
     * its event: `transition.written` with `needsHuman`, as `flagMergeFailure` writes it, unless the
     * caller names another.
     */
    private async flag(
        card: Card,
        pullRequest: CardPullRequest,
        reason: string,
        event?: { type: 'card.pull-request-closed'; payload: Record<string, unknown> },
    ): Promise<void> {
        const { id, stage } = card.frontmatter;
        await this.board.writeWithEvent(
            id,
            `Flag ${id}: ${reason}`,
            current => ({ ...current, frontmatter: { ...current.frontmatter, pullRequest, needsHuman: true, needsHumanReason: reason } }),
            {
                project: this.config.project,
                cardId: id,
                stage,
                type: event?.type ?? 'transition.written',
                payload: event ? { ...event.payload, reason } : { from: stage, to: stage, by: 'runner', needsHuman: true, reason },
            },
        );
    }
}
