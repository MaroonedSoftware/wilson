import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { DateTime } from 'luxon';
import { connectionRefused, fetchMock, jsonResponse, urlOf } from './sdk-fetch.helper.js';

// Card 0079: `daemonCurrent` no longer `pgrep`s a process line for `index.ts run` — the API is the
// only daemon now, and it can be asked directly. This check calls `apiClient(ctx).health.getHealth()`
// (`GET /api/health`) and compares the `startedAt` it reports against the working tree's HEAD commit
// time, the same staleness question card 0014 needed answered, just asked a different way.
const { daemonCurrent } = await import('../../../../packages/cli/src/checks/daemon.current.js');

const execFile = promisify(execFileCb);

type CheckResult = { ok: boolean; message: string; fixHint?: string };
type RunFn = (ctx: unknown) => Promise<CheckResult>;
const run = daemonCurrent.run as unknown as RunFn;

const buildCtx = (values: Record<string, string>) => ({ config: new AppConfig(values) });

/** A throwaway git repo whose one commit is stamped with `committerIso`, for `%cI` to report back. */
const repoWithCommitAt = async (committerIso: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'daemon-current-'));
    const opts = { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: committerIso, GIT_COMMITTER_DATE: committerIso } };
    await execFile('git', ['init', '-q'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'daemon-current-test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'daemon-current-test'], { cwd: root });
    await writeFile(join(root, 'file.txt'), 'content');
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], opts);
    return root;
};

describe('daemonCurrent', () => {
    it('asks the API for its health rather than shelling out to pgrep', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);

        await run(buildCtx({ PROJECT_CODE_ROOT: '/tmp/does-not-matter' }));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/health');
    });

    it('reports no daemon, passing, when the API is unreachable', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: '/tmp/does-not-matter' }));

        expect(result).toEqual({ ok: true, message: 'no daemon running' });
    });

    it('passes and names the project and start time when the daemon started after HEAD landed', async () => {
        const root = await repoWithCommitAt('2020-01-01T00:00:00Z');
        const startedAt = '2030-01-01T00:00:00.000Z';
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, project: 'wilson', head: 'abc123', startedAt }));

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(true);
        expect(result.message).toBe(`daemon is current (wilson), started ${DateTime.fromISO(startedAt).toISO()}`);
    });

    it('fails, naming both timestamps, when HEAD landed after the daemon started', async () => {
        const root = await repoWithCommitAt('2030-01-01T00:00:00Z');
        const startedAt = '2020-01-01T00:00:00.000Z';
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, project: 'wilson', head: 'abc123', startedAt }));

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toContain(DateTime.fromISO(startedAt).toISO());
        expect(result.fixHint).toContain('Restart it');
    });

    it('still reports the daemon as running, passing, when HEAD cannot be read', async () => {
        // A root that isn't a git repo at all: `git log` fails the way it would if
        // `PROJECT_CODE_ROOT` pointed somewhere without a working tree.
        const root = await mkdtemp(join(tmpdir(), 'daemon-current-no-git-'));
        const startedAt = '2020-01-01T00:00:00.000Z';
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, project: 'wilson', head: 'abc123', startedAt }));

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(true);
        expect(result.message).toBe(`daemon running (wilson), started ${DateTime.fromISO(startedAt).toISO()}; HEAD unavailable`);
    });
});
