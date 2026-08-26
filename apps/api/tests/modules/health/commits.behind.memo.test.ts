import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `commitsBehind` ran two git processes on every dispatch — `rev-parse HEAD` in `CardStageJob`, then
 * this one's `rev-list --count` — to answer a question about two fixed commits, which cannot change
 * once asked. The memo removes the second of those in the steady state a running board spends almost
 * all its time in: every dispatch between two merges asks the identical question.
 *
 * `git` is mocked here rather than exercised for real (health.service.test.ts already covers the
 * ancestry answers against a real repo) because what is under test is how often it is *called*, and
 * a real git makes that invisible.
 */
const gitMock = vi.fn();
vi.mock('#modules/board/git.js', () => ({ git: (cwd: string, args: string[]) => gitMock(cwd, args) }));

const { commitsBehind } = await import('#modules/health/health.service.js');
const { captureBuildHead } = await import('#src/server/build.info.js');

const CODE_ROOT = '/code';
const OTHER_ROOT = '/other-code';

/** `rev-list --count a..b` answers with a count on stdout; anything else here is `rev-parse`. */
const answering = (count: number) => async () => ({ stdout: `${count}\n`, stderr: '' });

describe('commitsBehind memoises its answer per code repo', () => {
    beforeAll(async () => {
        // The process's own commit, captured once — `buildHead()` is 'unknown' until this runs, and
        // `commitsBehind` returns 0 without asking git at all while it is.
        gitMock.mockImplementation(async () => ({ stdout: 'daemonsha\n', stderr: '' }));
        await captureBuildHead(CODE_ROOT);
    });

    beforeEach(() => {
        gitMock.mockReset();
    });

    it('asks git once for a given ref, then answers repeats from the memo', async () => {
        gitMock.mockImplementation(answering(3));

        expect(await commitsBehind(CODE_ROOT, 'ref-a')).toBe(3);
        expect(gitMock).toHaveBeenCalledTimes(1);

        expect(await commitsBehind(CODE_ROOT, 'ref-a')).toBe(3);
        expect(await commitsBehind(CODE_ROOT, 'ref-a')).toBe(3);
        expect(gitMock).toHaveBeenCalledTimes(1);
    });

    it('asks again once HEAD has moved to a ref it has not answered for', async () => {
        gitMock.mockImplementation(answering(1));
        await commitsBehind(CODE_ROOT, 'ref-b');
        expect(gitMock).toHaveBeenCalledTimes(1);

        gitMock.mockImplementation(answering(4));
        expect(await commitsBehind(CODE_ROOT, 'ref-c')).toBe(4);
        expect(gitMock).toHaveBeenCalledTimes(2);
    });

    it('keeps one slot per repo, so two code roots do not evict each other', async () => {
        gitMock.mockImplementation(answering(7));
        await commitsBehind(CODE_ROOT, 'shared-ref');
        gitMock.mockImplementation(answering(9));
        await commitsBehind(OTHER_ROOT, 'shared-ref');
        gitMock.mockReset();

        // Both answered from their own slot: same ref, different repo, neither re-asks.
        expect(await commitsBehind(CODE_ROOT, 'shared-ref')).toBe(7);
        expect(await commitsBehind(OTHER_ROOT, 'shared-ref')).toBe(9);
        expect(gitMock).not.toHaveBeenCalled();
    });

    /**
     * The case that makes this a memo of answers rather than a cache of returns. Both of
     * `commitsBehind`'s zeroes mean "cannot tell", and remembering one would report a daemon as
     * current for the rest of the process's life on the strength of one failed git call — turning a
     * transient failure into a permanent wrong answer from the check that exists to catch staleness.
     */
    it('never memoises a git failure, so the next call still asks', async () => {
        gitMock.mockImplementation(async () => {
            throw new Error('repo is mid-operation');
        });
        expect(await commitsBehind(CODE_ROOT, 'ref-d')).toBe(0);
        expect(gitMock).toHaveBeenCalledTimes(1);

        gitMock.mockImplementation(answering(5));
        expect(await commitsBehind(CODE_ROOT, 'ref-d')).toBe(5);
        expect(gitMock).toHaveBeenCalledTimes(2);
    });

    it('never memoises output that did not parse as a count', async () => {
        gitMock.mockImplementation(async () => ({ stdout: 'not-a-number\n', stderr: '' }));
        expect(await commitsBehind(CODE_ROOT, 'ref-e')).toBe(0);

        gitMock.mockImplementation(answering(6));
        expect(await commitsBehind(CODE_ROOT, 'ref-e')).toBe(6);
    });
});
