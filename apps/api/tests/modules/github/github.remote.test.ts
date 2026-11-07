import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubApp } from '#modules/github/github.app.js';
import { runGit, type GitRunner } from '#modules/github/github.git.js';
import { GitHubRemote, githubTrackingRef } from '#modules/github/github.remote.js';

const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await promisify(execFile)('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })).stdout.trim();

describe('GitHubRemote', () => {
    let root: string;
    let github: string;
    let clone: string;
    const tokenFor = vi.fn(async () => 'secret-token');
    const app = { tokenFor } as unknown as GitHubApp;
    const remote = (runner: GitRunner = runGit) => new GitHubRemote(app, runner, () => github);

    const commit = async (cwd: string, file: string): Promise<string> => {
        await writeFile(join(cwd, file), file);
        await git(cwd, 'add', file);
        await git(cwd, 'commit', '-m', file);
        return git(cwd, 'rev-parse', 'HEAD');
    };

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'remote-'));
        github = join(root, 'github.git');
        clone = join(root, 'clone');
        await git(root, 'init', '--bare', '-b', 'main', github);
        await git(root, 'clone', github, clone);
        await git(clone, 'checkout', '-b', 'main');
        await commit(clone, 'a');
        await git(clone, 'push', 'origin', 'main');
        tokenFor.mockClear();
    });
    afterEach(() => rm(root, { recursive: true, force: true }));

    it('fetches GitHub main into the tracking ref without moving the local branch', async () => {
        const local = await git(clone, 'rev-parse', 'main');
        const other = join(root, 'other');
        await git(root, 'clone', github, other);
        const ahead = await commit(other, 'b');
        await git(other, 'push', 'origin', 'main');

        const sha = await remote().fetchBranch(clone, 'acme/app', 'main');

        expect(sha).toBe(ahead);
        expect(await git(clone, 'rev-parse', githubTrackingRef('main'))).toBe(ahead);
        expect(await git(clone, 'rev-parse', 'main')).toBe(local);
    });

    it('pushes a commit to a new branch as the app', async () => {
        await git(clone, 'checkout', '-b', 'card/0042');
        const sha = await commit(clone, 'c');
        const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];

        await remote(async (args, env) => {
            calls.push({ args, env });
            return runGit(args, env);
        }).push(clone, 'acme/app', sha, 'card/0042');

        expect(await git(github, 'rev-parse', 'refs/heads/card/0042')).toBe(sha);
        expect(calls[0]!.env?.WILSON_GIT_TOKEN).toBe('secret-token');
        expect(calls[0]!.args.join(' ')).not.toContain('secret-token');
        expect(calls[0]!.args).not.toContain('--force');
    });

    it('refuses with a 409 rather than overwrite a branch someone moved on GitHub', async () => {
        await git(clone, 'checkout', '-b', 'card/0042');
        const ours = await commit(clone, 'c');
        const other = join(root, 'other');
        await git(root, 'clone', github, other);
        await git(other, 'checkout', '-b', 'card/0042');
        const theirs = await commit(other, 'd');
        await git(other, 'push', 'origin', 'card/0042');

        await expect(remote().push(clone, 'acme/app', ours, 'card/0042')).rejects.toMatchObject({ statusCode: 409 });
        expect(await git(github, 'rev-parse', 'refs/heads/card/0042')).toBe(theirs);
    });

    it('reports any other failure as a 503 with git’s last line', async () => {
        const failing: GitRunner = async () => {
            throw Object.assign(new Error('git failed'), { stderr: 'remote: nope\nfatal: Authentication failed\n' });
        };

        await expect(remote(failing).push(clone, 'acme/app', 'abc', 'card/0042')).rejects.toMatchObject({
            statusCode: 503,
            details: { reason: expect.stringContaining('Authentication failed') },
        });
    });
});
