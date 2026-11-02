import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Enough to compare a card's recent attempts, on a board where one report runs to megabytes. */
const MAX_REPORTS_KEPT = 5;

/**
 * Keep a red run's whole test report under the run root, on the daemon's own disk, beside the
 * card's `last-failed-attempt.patch`, and answer where it went.
 *
 * A report lives in its worktree, and a worktree does not outlast its stage: the merge check
 * deletes its own unconditionally, and on a worker the tree can be gone before anyone reads the
 * failure. Card 0007's testing stage failed 29 tests on a worker for a reason nobody could recover
 * for exactly that reason. The caller passes the contents rather than a path because a report on a
 * worker is only reachable through its `ExecutionHost`.
 *
 * Names sort by time, so the oldest are the first to go.
 */
export const archiveTestReport = async (runRoot: string, cardId: string, label: string, raw: string): Promise<string> => {
    const dir = join(runRoot, 'cards', cardId, 'test-reports');
    await mkdir(dir, { recursive: true });

    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
    await writeFile(path, raw);

    const names = (await readdir(dir)).sort();
    await Promise.all(names.slice(0, -MAX_REPORTS_KEPT).map(name => rm(join(dir, name), { force: true })));
    return path;
};
