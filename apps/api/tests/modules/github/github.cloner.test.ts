import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubApp } from '#modules/github/github.app.js';
import { GitHubCloner, type GitRunner } from '#modules/github/github.cloner.js';

describe('GitHubCloner', () => {
    let parent: string;
    let target: string;
    const tokenFor = vi.fn(async () => 'secret-token');
    const app = { tokenFor } as unknown as GitHubApp;

    beforeEach(async () => {
        parent = await mkdtemp(join(tmpdir(), 'cloner-'));
        target = join(parent, 'nested', 'app');
        tokenFor.mockClear();
    });
    afterEach(() => rm(parent, { recursive: true, force: true }));

    /** Stands in for `git clone`, making the folder it was told to. */
    const cloning = (fail?: string) => {
        const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
        const git: GitRunner = async (args, env) => {
            calls.push({ args, env });
            if (args.includes('clone')) {
                await mkdir(args.at(-1)!, { recursive: true });
                if (fail) throw Object.assign(new Error('git failed'), { stderr: `Cloning...\n${fail}\n` });
            }
            return { stdout: '' };
        };
        return { git, calls };
    };

    const existing = async (origin: string | undefined) => {
        await mkdir(target, { recursive: true });
        const git: GitRunner = async () => {
            if (origin === undefined) throw new Error('no such remote');
            return { stdout: `${origin}\n` };
        };
        return git;
    };

    it('clones to the destination with the token in the environment, never in the arguments', async () => {
        const { git, calls } = cloning();

        await new GitHubCloner(app, git).clone('acme/app', target);

        expect(tokenFor).toHaveBeenCalledWith('acme/app');
        expect(await readdir(join(parent, 'nested'))).toEqual(['app']);
        expect(calls[0]!.args).toContain('https://github.com/acme/app.git');
        expect(calls[0]!.args.join(' ')).not.toContain('secret-token');
        expect(calls[0]!.env).toMatchObject({ WILSON_GIT_TOKEN: 'secret-token', GIT_TERMINAL_PROMPT: '0' });
    });

    it("leaves nothing behind when the clone fails, and passes on git's own reason", async () => {
        const { git } = cloning('fatal: repository not found');

        await expect(new GitHubCloner(app, git).clone('acme/app', target)).rejects.toMatchObject({
            statusCode: 502,
            details: { reason: 'could not clone acme/app: fatal: repository not found' },
        });
        expect(await readdir(join(parent, 'nested'))).toEqual([]);
    });

    it.each(['https://github.com/acme/app.git', 'https://github.com/Acme/App', 'git@github.com:acme/app.git'])(
        'accepts a folder already cloned from %s, without asking for a token',
        async origin => {
            await new GitHubCloner(app, await existing(origin)).clone('acme/app', target);

            expect(tokenFor).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['another repository', 'https://github.com/acme/other.git'],
        ['no repository at all', undefined],
    ])('refuses a folder holding %s', async (_, origin) => {
        await writeFile(join(parent, 'marker'), '');

        await expect(new GitHubCloner(app, await existing(origin)).clone('acme/app', target)).rejects.toMatchObject({ statusCode: 409 });
        expect(tokenFor).not.toHaveBeenCalled();
    });
});
