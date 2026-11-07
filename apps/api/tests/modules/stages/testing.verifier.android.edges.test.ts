import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { isAndroidOnlyDiff, KOTLIN_TEST_COMMAND, TestingVerifier } from '#modules/stages/testing.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import { planlessCard, stageDefaults } from '#tests/modules/stages/stage.fixture.js';

const exec = promisify(execFile);

const NO_TS_TEST = 'the diff contains no file matching *.test.ts: the testing stage added no tests';

describe('isAndroidOnlyDiff — edges (card 0037)', () => {
    it('is false when a diff adds a Kotlin test and a *.test.ts together', () => {
        expect(isAndroidOnlyDiff(['apps/android/app/src/test/java/FeatureTest.kt', 'apps/api/tests/thing.test.ts'])).toBe(false);
    });

    it('is false for a path that only looks Android-ish', () => {
        expect(isAndroidOnlyDiff(['apps/android-tools/build.ts'])).toBe(false);
        expect(isAndroidOnlyDiff(['apps/api/src/apps/android/thing.kt'])).toBe(false);
    });

    it('is false for a non-Markdown file alongside, such as JSON config', () => {
        expect(isAndroidOnlyDiff(['apps/android/app/src/main/java/Feature.kt', 'package.json'])).toBe(false);
    });
});

describe('CommandAllowlist — gradle entries match verbatim only (card 0037)', () => {
    it('does not treat a short gradle entry as a prefix for other tasks', () => {
        const list = new CommandAllowlist(['./gradlew']);
        expect(list.check('./gradlew').allowed).toBe(true);
        const decision = list.check('./gradlew :app:assembleRelease');
        expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining('exactly as configured') });
    });

    it('refuses the configured command with an argument missing', () => {
        const list = new CommandAllowlist([KOTLIN_TEST_COMMAND]);
        expect(list.check('apps/android/gradlew -p apps/android').allowed).toBe(false);
    });

    it('accepts the configured command with extra whitespace between the same tokens', () => {
        const list = new CommandAllowlist([KOTLIN_TEST_COMMAND]);
        expect(list.check(`  ${KOTLIN_TEST_COMMAND.split(' ').join('   ')}  `).allowed).toBe(true);
    });
});

/**
 * `TestingVerifier.verify` against a real git repo, for the Android paths the main suite leaves out.
 * `apps/android/gradlew` stands in for gradle: it fails while `app/src/test` exists without
 * `Feature.kt` beside it, and passes otherwise.
 */
describe('TestingVerifier — Android-only edges (card 0037)', () => {
    let base: string;
    let manager: WorktreeManager;
    let verifier: TestingVerifier;
    let warn: ReturnType<typeof vi.fn>;

    const FAKE_GRADLEW = [
        '#!/bin/sh',
        'if [ -d apps/android/app/src/test ] && [ ! -f apps/android/app/src/main/Feature.kt ]; then',
        '  echo "Unresolved reference: Feature" >&2',
        '  exit 1',
        'fi',
        'exit 0',
        '',
    ].join('\n');

    const FEATURE = 'apps/android/app/src/main/Feature.kt';
    const FEATURE_TEST = 'apps/android/app/src/test/java/FeatureTest.kt';
    const OLD_TEST = 'apps/android/core/src/test/OldTest.kt';

    const makeStage = (overrides: Partial<StageConfig> = {}): StageConfig => ({
        ...stageDefaults,
        name: 'testing',
        mode: 'agent',
        worktree: 'rw',
        provider: 'anthropic',
        model: 'claude-opus',
        instructions: 'test the thing',
        allowedCommands: [],
        worktreeFrom: 'branch',
        extraScope: [],
        baselineCheck: false,
        assertionCheck: true,
        maxSteps: 60,
        maxOutputTokens: 16000,
        onPass: 'review',
        onFail: 'implementing',
        maxKickbacks: 3,
        ...overrides,
    });

    const verifyInput = (worktree: Awaited<ReturnType<WorktreeManager['create']>>, stage: StageConfig) => ({
        worktree,
        stage,
        cardId: '0001',
        card: planlessCard(),
        scope: {} as ScopeGuard,
        result: undefined,
    });

    const put = async (root: string, path: string, content: string, mode?: number): Promise<void> => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content, { encoding: 'utf8', ...(mode ? { mode } : {}) });
    };

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'testing-verifier-android-edges-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await put(codeRoot, 'apps/android/gradlew', FAKE_GRADLEW, 0o755);
        await put(codeRoot, 'apps/android/app/src/main/App.kt', 'class App\n');
        await put(codeRoot, OLD_TEST, 'class OldTest\n');
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        warn = vi.fn();
        const logger = { info: () => {}, warn, error: () => {}, debug: () => {} };
        const config = new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run'));
        manager = new WorktreeManager(config, logger as never);
        verifier = new TestingVerifier(manager, logger as never, {} as EventLog, config);
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true }).catch(() => undefined);
    });

    it('does not trip the baseline copy over a Kotlin test the card deleted', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await rm(join(worktree.path, OLD_TEST));
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage({ baselineCheck: true })));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
    });

    it('logs the Kotlin baseline check as skipped, not passed, when baselineCheck is off', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage({ baselineCheck: false })));

        expect(outcome.passed).toBe(true);
        const lines = warn.mock.calls.map(call => String(call[0]));
        expect(lines.some(line => line.includes('Kotlin baseline check was skipped, not passed'))).toBe(true);
    });

    it('still runs the format check for an Android-only card', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage({ formatCommand: 'false' })));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toHaveLength(1);
        expect(outcome.failures).not.toContain(NO_TS_TEST);
    });

    it('still flags a credential added to an Android-only diff', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        const key = 'AKIA' + 'Q7ZK3MWR2VHN5TLB';
        await put(worktree.path, FEATURE, `class Feature { val key = "${key}" }\n`);
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage()));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures[0]).toContain(`${FEATURE}:1 adds a suspected AWS access key`);
        expect(outcome.needsHumanReason).toContain('possible credential');
        expect(outcome.failures).not.toContain(NO_TS_TEST);
    });

    it('does not count a Kotlin test outside apps/android/**/src/test as the added test', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, 'apps/android/app/src/androidTest/java/FeatureTest.kt', 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage()));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('contains no file matching apps/android/**/src/test/**/*Test.kt'))).toBe(true);
    });
});
