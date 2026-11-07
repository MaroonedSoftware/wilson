import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ANDROID_SKIPPED_CHECKS,
    isAndroidOnlyDiff,
    KOTLIN_TEST_FILE_PATTERN,
    NO_KOTLIN_TEST_FAILURE,
    TestingVerifier,
} from '#modules/stages/testing.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import { planlessCard, stageDefaults } from '#tests/modules/stages/stage.fixture.js';

const exec = promisify(execFile);

const NO_TS_TEST = 'the diff contains no file matching *.test.ts: the testing stage added no tests';

describe('KOTLIN_TEST_FILE_PATTERN (card 0037)', () => {
    it.each([
        'apps/android/app/src/test/java/com/wilson/FeatureTest.kt',
        'apps/android/app/src/test/kotlin/FeatureTest.kt',
        'apps/android/core/src/test/FeatureTest.kt',
    ])('matches a unit test: %s', path => {
        expect(KOTLIN_TEST_FILE_PATTERN.test(path)).toBe(true);
    });

    it.each([
        // An instrumented test needs the emulator, which no stage runs.
        'apps/android/app/src/androidTest/java/FeatureTest.kt',
        'apps/android/app/src/main/java/Feature.kt',
        'apps/android/app/src/test/java/FeatureHelper.kt',
        'apps/android/app/src/test/java/FeatureTest.java',
        'packages/sdk-kotlin/src/test/kotlin/ClientTest.kt',
        'apps/api/src/test/FeatureTest.kt',
    ])('does not match: %s', path => {
        expect(KOTLIN_TEST_FILE_PATTERN.test(path)).toBe(false);
    });
});

describe('isAndroidOnlyDiff (card 0037)', () => {
    it('is true for Android and Kotlin SDK paths alone', () => {
        expect(isAndroidOnlyDiff(['apps/android/app/src/main/java/Feature.kt', 'packages/sdk-kotlin/src/main/kotlin/Client.kt'])).toBe(true);
    });

    it('allows Markdown and runner bookkeeping alongside', () => {
        expect(isAndroidOnlyDiff(['apps/android/app/src/main/java/Feature.kt', '.changeset/kotlin.md', 'PROJECT.md', '.wilson-report.json'])).toBe(
            true,
        );
    });

    it('is false for a mixed diff that also touches TypeScript', () => {
        expect(isAndroidOnlyDiff(['apps/android/app/src/main/java/Feature.kt', 'apps/api/src/modules/thing.ts'])).toBe(false);
    });

    it('is false for any other non-Android code', () => {
        expect(isAndroidOnlyDiff(['apps/android/app/src/main/java/Feature.kt', 'apps/desktop/src/Thing.cs'])).toBe(false);
    });

    it('is false for a diff with no Android path at all, including an empty or docs-only one', () => {
        expect(isAndroidOnlyDiff([])).toBe(false);
        expect(isAndroidOnlyDiff(['PROJECT.md'])).toBe(false);
        expect(isAndroidOnlyDiff(['apps/api/src/thing.ts'])).toBe(false);
    });
});

/**
 * `TestingVerifier.verify` end to end against a real git repo. `apps/android/gradlew` is a small
 * script standing in for gradle: it fails while any unit test exists without `Feature.kt` beside it
 * — what a Kotlin test that does not compile against the pre-change tree looks like — and passes
 * otherwise. That is enough to drive both the stage's own run and the baseline run.
 */
describe('TestingVerifier — Android-only diffs (card 0037)', () => {
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

    const FEATURE = 'apps/android/app/src/main/Feature.kt';
    const FEATURE_TEST = 'apps/android/app/src/test/java/FeatureTest.kt';

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'testing-verifier-android-'));
        const codeRoot = join(base, 'code');
        await mkdir(codeRoot, { recursive: true });

        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await put(codeRoot, 'apps/android/gradlew', FAKE_GRADLEW, 0o755);
        await put(codeRoot, 'apps/android/app/src/main/App.kt', 'class App\n');
        await put(codeRoot, 'apps/api/src/thing.ts', 'export const thing = 1;\n');
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

    it('passes the no-tests check when an Android-only diff adds a Kotlin test, and passes overall when gradle is green', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage({ testCommand: 'false', testReportPath: 'report.json' })));

        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
    });

    it('fails an Android-only diff with no Kotlin test, asking for one rather than a *.test.ts', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage()));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toContain(NO_KOTLIN_TEST_FAILURE);
        expect(outcome.failures).not.toContain(NO_TS_TEST);
    });

    it('still needs a *.test.ts when a diff with a Kotlin test also changes TypeScript source', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');
        await put(worktree.path, 'apps/api/src/thing.ts', 'export const thing = 2;\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage()));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures).toContain(NO_TS_TEST);
    });

    it('still needs a *.test.ts for a TypeScript-only diff', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, 'apps/api/src/thing.ts', 'export const thing = 2;\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage()));

        expect(outcome.failures).toContain(NO_TS_TEST);
    });

    it('fails the stage when the Kotlin unit tests are red', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage()));

        expect(outcome.passed).toBe(false);
        const red = outcome.failures.find(f => f.startsWith('the Kotlin unit tests are not green'));
        expect(red).toBeDefined();
        expect(red).toContain('Unresolved reference: Feature');
    });

    it('does not run the vitest command or read its report, and logs those checks as skipped', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        // A vitest command that would fail, and a report path that does not exist: neither is touched.
        const outcome = await verifier.verify(verifyInput(worktree, makeStage({ testCommand: 'false', testReportPath: 'missing.json' })));

        expect(outcome.failures.some(f => f.includes('missing.json') || f.includes('suite is not green'))).toBe(false);
        const logged = warn.mock.calls.map(call => String(call[0])).find(line => line.includes('Skipped, not passed'));
        expect(logged).toBeDefined();
        for (const check of ANDROID_SKIPPED_CHECKS) expect(logged).toContain(check);
    });

    it('passes the failing-before check when the new Kotlin test fails on the pre-change tree', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        await put(worktree.path, FEATURE, 'class Feature\n');
        await put(worktree.path, FEATURE_TEST, 'class FeatureTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage({ baselineCheck: true })));

        expect(outcome.failures).toEqual([]);
    });

    it('fails the failing-before check when the new Kotlin test passes on the pre-change tree too', async () => {
        const worktree = await manager.create('0001', 'card/0001-thing');
        // The gradle stand-in only fails for a test under app/src/test without Feature.kt, so a
        // card that changes App.kt and tests it in another module proves nothing.
        await put(worktree.path, 'apps/android/app/src/main/App.kt', 'class App(val x: Int)\n');
        await put(worktree.path, 'apps/android/core/src/test/AppTest.kt', 'class AppTest\n');

        const outcome = await verifier.verify(verifyInput(worktree, makeStage({ baselineCheck: true })));

        expect(outcome.passed).toBe(false);
        expect(outcome.failures.some(f => f.includes('pass against the pre-change tree') && f.includes('AppTest.kt'))).toBe(true);
    });
});
