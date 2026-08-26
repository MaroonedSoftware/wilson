import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { ImplementingVerifier } from '#modules/stages/implementing.verifier.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
    name: 'implementing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'do the thing',
    allowedCommands: [],
    worktreeFrom: 'base',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'testing',
    onFail: 'needs-human',
    maxKickbacks: 3,
    ...overrides,
});

/**
 * Card 0041: formatting is now part of `ImplementingVerifier`'s own exit condition — `checkFormat`,
 * shared with `TestingVerifier` (`stage.verifier.ts`) — rather than something an agent's
 * instructions merely ask for. These tests exercise the wiring against a real git worktree, the
 * way `TestingVerifier`'s own tests do, and the repo's real `prettier` binary rather than a stub
 * for `runConfiguredCommand` — the thing actually in question is whether that command's failure
 * reaches `verify`'s failures naming the offending file, not whether the two agree about a mock.
 */
describe('ImplementingVerifier — format check', () => {
    let base: string;
    let manager: WorktreeManager;
    let verifier: ImplementingVerifier;
    let prettierBin: string;

    beforeEach(async () => {
        const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
        prettierBin = join(repoRoot, 'node_modules', '.bin', 'prettier');

        base = await mkdtemp(join(tmpdir(), 'implementing-verifier-format-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'README.md'), '# base\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig('test', join(base, 'board'), codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        verifier = new ImplementingVerifier(manager);
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true }).catch(() => undefined);
    });

    const verify = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, stage: StageConfig) => {
        // A permissive scope: format-check wiring is what these tests are about, not the separate
        // scope re-check `ImplementingVerifier` also runs.
        const scope = new ScopeGuard({ worktreeRoot: worktree.path, allow: ['**'], alwaysAllowed: [] });
        return verifier.verify({ worktree, scope, stage, cardId: '0001', result: undefined });
    };

    it('fails and names the file when the stage leaves something prettier would reformat', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'bad.ts'), 'const x = {a:1,   b :2}\n', 'utf8');

        const outcome = await verify(worktree, makeStage({ formatCommand: `${prettierBin} --check .` }));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('bad.ts'))).toBe(true);
    });

    it('passes the format check once the stage’s own file is actually formatted', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'good.ts'), 'const x = {a:1,   b :2}\n', 'utf8');
        // Normalise with the real formatter rather than hand-typing what "already formatted" looks
        // like — the point is that *prettier's own opinion* is satisfied, not a guess at it.
        await exec(prettierBin, ['--write', '.'], { cwd: worktree.path });

        const outcome = await verify(worktree, makeStage({ formatCommand: `${prettierBin} --check .` }));

        expect(outcome.failures.some(f => f.includes('good.ts'))).toBe(false);
        expect(outcome.passed).toBe(true);
    });

    it('runs no format check at all, and still passes, when formatCommand is not configured — even on an unformatted file', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await writeFile(join(worktree.path, 'bad.ts'), 'const x = {a:1,   b :2}\n', 'utf8');

        const outcome = await verify(worktree, makeStage());

        expect(outcome.failures.some(f => f.includes('bad.ts'))).toBe(false);
        expect(outcome.passed).toBe(true);
    });
});
