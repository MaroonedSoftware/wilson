import { mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Card 0071: `WorktreeManager.commit` now passes `--no-verify`, so a project's `core.hooksPath`
// hooks never run on a stage's commit. Silently bypassing something an operator configured on
// purpose deserves a notice — this check reports what `core.hooksPath` resolves to and that stage
// commits bypass it, without ever failing the check over it.
const { codeRepoReady } = await import('../../../../packages/cli/src/checks/code.repo.js');

const execFile = promisify(execFileCb);

type CheckResult = { ok: boolean; message: string; fixHint?: string };
type RunFn = (ctx: unknown) => Promise<CheckResult>;
const run = codeRepoReady.run as unknown as RunFn;

// Card 0247: `PROJECT_CODE_ROOT` is read via `setting(ctx, ...)` off `ctx.env`, not `ctx.config` —
// this `ctx` carries only `env`, no `config` at all, so a reader that still reached for
// `ctx.config` would throw here rather than merely mis-report.
const buildCtx = (values: Record<string, string>) => ({ env: values });

const initRepo = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'code-repo-'));
    await execFile('git', ['init', '-q'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'code-repo-test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'code-repo-test'], { cwd: root });
    await writeFile(join(root, 'file.txt'), 'content');
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: root });
    return root;
};

describe('codeRepoReady', () => {
    it('fails when PROJECT_CODE_ROOT is not set', async () => {
        const result = await run(buildCtx({}));
        expect(result.ok).toBe(false);
        expect(result.message).toBe('PROJECT_CODE_ROOT is not set');
    });

    it('reports nothing new for a project with no core.hooksPath configured', async () => {
        const root = await initRepo();

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(true);
        expect(result.message).not.toContain('hooksPath');
        expect(result.message).not.toContain('bypass');
    });

    it('reports nothing new when core.hooksPath is configured but the directory is empty', async () => {
        const root = await initRepo();
        await mkdir(join(root, 'hooks'), { recursive: true });
        await execFile('git', ['config', 'core.hooksPath', 'hooks'], { cwd: root });

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(true);
        expect(result.message).not.toContain('hooksPath');
    });

    it('reports nothing new when core.hooksPath is configured but names a directory that does not exist', async () => {
        const root = await initRepo();
        await execFile('git', ['config', 'core.hooksPath', 'no-such-dir'], { cwd: root });

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(true);
        expect(result.message).not.toContain('hooksPath');
    });

    it('notices a configured core.hooksPath that actually holds hooks, and says stage commits bypass it', async () => {
        const root = await initRepo();
        const hooksDir = join(root, 'hooks');
        await mkdir(hooksDir, { recursive: true });
        const hookPath = join(hooksDir, 'pre-commit');
        await writeFile(hookPath, '#!/bin/sh\nexit 1\n');
        await chmod(hookPath, 0o755);
        await execFile('git', ['config', 'core.hooksPath', 'hooks'], { cwd: root });

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        // Informational, not a failure: a project with hooks is not misconfigured.
        expect(result.ok).toBe(true);
        expect(result.message).toContain('core.hooksPath=hooks');
        expect(result.message).toContain('1 hook');
        expect(result.message).toContain('bypass');
    });

    it('counts every hook in the directory, pluralizing the notice', async () => {
        const root = await initRepo();
        const hooksDir = join(root, 'hooks');
        await mkdir(hooksDir, { recursive: true });
        await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
        await writeFile(join(hooksDir, 'commit-msg'), '#!/bin/sh\nexit 1\n');
        await execFile('git', ['config', 'core.hooksPath', 'hooks'], { cwd: root });

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.message).toContain('2 hooks');
        expect(result.message).toContain('bypass them');
    });

    it('still passes and fails exactly as before, alongside the hooks notice', async () => {
        const root = await initRepo();
        const { stdout } = await execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(true);
        expect(result.message).toContain(`${root} @ ${stdout.trim()}`);
    });

    it('fails, naming the fix, when the repo has no commits', async () => {
        const root = await mkdtemp(join(tmpdir(), 'code-repo-unborn-'));
        await execFile('git', ['init', '-q'], { cwd: root });

        const result = await run(buildCtx({ PROJECT_CODE_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toBe('no commits on the current branch');
        expect(result.fixHint).toContain('initial commit');
    });
});
