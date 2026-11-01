import { describe, expect, it, vi } from 'vitest';
import type { JobRunner } from '@maroonedsoftware/jobbroker';
import { stopCardStageJobs } from '#modules/jobs/jobs.module.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { currentProject } from '#modules/board/project.context.js';

/**
 * Card 0149 review finding (blocker), fixed after the first testing pass: `stopCardStageJobs` walks
 * `RunningCards.snapshot()` and calls `CardJobs.confirmInFlightAfterStop(cardId)` for each entry.
 * `CardJobs` reads `BoardConfig.project` — i.e. whatever `currentProject()` answers — with no scope
 * of its own, so unless `stopCardStageJobs` wraps each call in `runAsProject(project, ...)` for the
 * project *that specific card* ran under, every confirmation resolves against whatever project
 * happens to be ambient (typically none, or the daemon's own default) instead of the card's actual
 * project. A card belonging to a non-default project would then have its shutdown confirmation run
 * against the wrong project's `wilson.cardJobs` row: find nothing there, and report a genuinely
 * abandoned card as cleanly settled — silently losing exactly the "stop() resolved cleanly while a
 * job kept running" defect `RunningCards`/`stopCardStageJobs` exist to catch.
 *
 * This fake `CardJobs.confirmInFlightAfterStop` does not touch `BoardConfig` directly — it reads
 * `currentProject()` itself, so these tests observe what project was ambient for each call exactly
 * the way the real `CardJobs`/`BoardConfig` would, without needing a full `BoardConfig` double.
 */

type FakeCardJobs = { confirmInFlightAfterStop: ReturnType<typeof vi.fn> };

const fakeCardJobs = (jobIdByProjectAndCard: Record<string, string>): FakeCardJobs => ({
    confirmInFlightAfterStop: vi.fn(async (cardId: string) => {
        const project = currentProject();
        return jobIdByProjectAndCard[`${project}:${cardId}`];
    }),
});

const fakeRunner = (stop: () => Promise<void>): JobRunner => ({ start: vi.fn(), stop }) as unknown as JobRunner;

describe('stopCardStageJobs scopes each confirmation to the project its card ran under (card 0149)', () => {
    it("resolves each RunningCards entry's confirmation under that entry's own project, not a shared/default one", async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('alpha', '0001');
        running.add('beta', '0001');

        // Same card id in both projects — if project scoping were missing or wrong, one or both
        // lookups would land on the wrong project's entry (or none at all, since the fake keys by
        // `${project}:${cardId}` and would see `undefined:0001` / a stale ambient project instead).
        const cardJobs = fakeCardJobs({ 'alpha:0001': 'job-alpha', 'beta:0001': 'job-beta' });

        const report = await stopCardStageJobs(runner, running, cardJobs as never);

        expect(report.abandoned.slice().sort((a, b) => a.jobId.localeCompare(b.jobId))).toEqual([
            { cardId: '0001', jobId: 'job-alpha' },
            { cardId: '0001', jobId: 'job-beta' },
        ]);
        expect(report.unconfirmed).toEqual([]);
    });

    it('leaves no project ambient once stopCardStageJobs itself returns', async () => {
        const runner = fakeRunner(vi.fn().mockResolvedValue(undefined));
        const running = new RunningCards();
        running.add('alpha', '0001');
        const cardJobs = fakeCardJobs({ 'alpha:0001': 'job-alpha' });

        expect(currentProject()).toBeUndefined();
        await stopCardStageJobs(runner, running, cardJobs as never);
        expect(currentProject()).toBeUndefined();
    });
});
