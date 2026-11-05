import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import { ImplementingVerifier } from '#modules/stages/implementing.verifier.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { checkSecrets } from '#modules/stages/stage.verifier.js';
import { TestingVerifier } from '#modules/stages/testing.verifier.js';
import { WorktreeManager, type Worktree } from '#modules/worktree/worktree.manager.js';
import { planlessCard, stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import { fakeSecrets } from './secret.fixture.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const withConstraints = (constraints: string): Card => ({ ...planlessCard(), sections: { Constraints: constraints } });

/** Real git: what is in question is whether a value in the tree reaches a verdict, by whichever route. */
describe('the secret check against a real worktree', () => {
    let base: string;
    let manager: WorktreeManager;
    let worktree: Worktree;
    let config: StaticBoardConfig;

    const write = async (path: string, content: string): Promise<void> => {
        await mkdir(dirname(join(worktree.path, path)), { recursive: true });
        await writeFile(join(worktree.path, path), content, 'utf8');
    };

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'stage-verifier-secrets-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await writeFile(join(codeRoot, 'kept.ts'), `export const old = "${fakeSecrets.aws}";\nexport const kept = 1;\n`, 'utf8');
        await writeFile(join(codeRoot, '.gitignore'), '*.local\n', 'utf8');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, silentLogger as never);
        worktree = await manager.create('0001', 'card/0001');
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true });
    });

    const check = (card: Card = planlessCard()) => checkSecrets(manager, worktree, card);

    it('flags a person, naming the file and line of an untracked file', async () => {
        await write('src/new.ts', `export const a = 1;\nexport const key = "${fakeSecrets.github}";\n`);

        const { failures, needsHumanReason } = await check();

        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('src/new.ts:2 adds a suspected GitHub token');
        expect(needsHumanReason).toContain('src/new.ts:2');
    });

    it('finds a line added to a tracked file, numbered as it now stands', async () => {
        await write('kept.ts', `export const old = "${fakeSecrets.aws}";\nexport const kept = 1;\nexport const key = "${fakeSecrets.anthropic}";\n`);

        const { failures } = await check();

        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('kept.ts:3 adds a suspected Anthropic API key');
    });

    it('sees what an earlier stage committed', async () => {
        await write('src/new.ts', `export const key = "${fakeSecrets.openaiProject}";\n`);
        await manager.commit(worktree, 'an earlier stage');

        expect((await check()).failures[0]).toContain('src/new.ts:1');
    });

    it('never puts the value in a failure or the reason', async () => {
        const values = [fakeSecrets.github, fakeSecrets.aws, fakeSecrets.anthropic, fakeSecrets.openaiProject, fakeSecrets.pemBody];
        await write('src/new.ts', `${values.join('\n')}\n${fakeSecrets.pemHeader}\n${fakeSecrets.pemBody}\n`);

        const { failures, needsHumanReason } = await check();

        expect(failures.length).toBeGreaterThanOrEqual(5);
        for (const value of values) {
            expect(failures.join('\n')).not.toContain(value);
            expect(needsHumanReason).not.toContain(value);
        }
    });

    it('leaves alone a value already at the fork point, a deletion, and an ignored file', async () => {
        await write('kept.ts', 'export const kept = 2;\n');
        await write('secrets.local', `${fakeSecrets.github}\n`);

        expect(await check()).toEqual({ failures: [] });
    });

    it('reads a symlink as its target name, and is not stopped by a dangling one', async () => {
        await symlink('/nowhere/at/all', join(worktree.path, 'dangling'));

        expect(await check()).toEqual({ failures: [] });
    });

    it('does not read a binary file', async () => {
        await writeFile(join(worktree.path, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(fakeSecrets.github)]));

        expect(await check()).toEqual({ failures: [] });
    });

    it('allows a finding in a file the plan declares, and only that file', async () => {
        await write('tests/fixture.ts', `export const key = "${fakeSecrets.github}";\n`);
        const declared = withConstraints('- Expected secret: tests/fixture.ts (a fake token for the parser test)');

        expect(await check(declared)).toEqual({ failures: [] });

        await write('src/real.ts', `export const key = "${fakeSecrets.github}";\n`);
        const { failures } = await check(declared);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('src/real.ts:1');
    });

    it('does not take a declaration with no reason', async () => {
        await write('tests/fixture.ts', `export const key = "${fakeSecrets.github}";\n`);

        expect((await check(withConstraints('- Expected secret: tests/fixture.ts'))).failures).toHaveLength(1);
    });

    it('fails without a flag or the error text when the diff cannot be read', async () => {
        const broken = { addedLines: async () => Promise.reject(new Error(`boom ${fakeSecrets.github}`)) } as unknown as WorktreeManager;

        const { failures, needsHumanReason } = await checkSecrets(broken, worktree, planlessCard());

        expect(failures).toEqual([expect.stringContaining('could not read')]);
        expect(failures[0]).not.toContain(fakeSecrets.github);
        expect(needsHumanReason).toBeUndefined();
    });

    it('fails ImplementingVerifier and leads with it, passing the reason on', async () => {
        await write('src/new.ts', `export const key = "${fakeSecrets.github}";\n`);
        const stage = { ...stageDefaults, name: 'implementing', formatCommand: undefined, buildCommand: undefined } as unknown as StageConfig;
        const scope = new ScopeGuard({ worktreeRoot: worktree.path, allow: ['**'], alwaysAllowed: [] });

        const outcome = await new ImplementingVerifier(manager).verify({ worktree, scope, stage, cardId: '0001', card: planlessCard(), result: {} });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain('src/new.ts:1');
        expect(outcome.needsHumanReason).toContain('src/new.ts:1');
    });

    it('fails TestingVerifier and leads with it, passing the reason on', async () => {
        await write('tests/new.test.ts', `export const key = "${fakeSecrets.github}";\n`);
        const stage = { ...stageDefaults, name: 'testing', baselineCheck: false, assertionCheck: false } as unknown as StageConfig;
        const scope = new ScopeGuard({ worktreeRoot: worktree.path, allow: ['**'], alwaysAllowed: [] });
        const verifier = new TestingVerifier(manager, silentLogger as never, {} as EventLog, config);

        const outcome = await verifier.verify({ worktree, scope, stage, cardId: '0001', card: planlessCard(), result: {} });

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain('tests/new.test.ts:1');
        expect(outcome.needsHumanReason).toContain('tests/new.test.ts:1');
    });

    it('sets no reason on ImplementingVerifier when the diff is clean', async () => {
        await write('src/new.ts', 'export const fine = 1;\n');
        const stage = { ...stageDefaults, name: 'implementing', formatCommand: undefined, buildCommand: undefined } as unknown as StageConfig;
        const scope = new ScopeGuard({ worktreeRoot: worktree.path, allow: ['**'], alwaysAllowed: [] });

        const outcome = await new ImplementingVerifier(manager).verify({ worktree, scope, stage, cardId: '0001', card: planlessCard(), result: {} });

        expect(outcome.passed).toBe(true);
        expect(outcome.needsHumanReason).toBeUndefined();
    });
});
