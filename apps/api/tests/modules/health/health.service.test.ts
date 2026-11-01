import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { HealthService, commitsBehind } from '#modules/health/health.service.js';
import { captureBuildHead } from '#src/server/build.info.js';

const exec = promisify(execFile);

// Card 0079 added `startedAt` to what `/api/health` reports, so `wilson doctor`'s "daemon not
// stale" check can ask the API when it came up instead of `pgrep`ing a process line. It has to be
// captured once, when the process boots, not computed per request — a live clock read would report
// "now" for a daemon that started hours ago, which is exactly the daemon a staleness check needs to
// catch.
const buildConfig = (project = 'wilson') => new StaticBoardConfig(project, '/code', '/worktrees', '/run');

describe('HealthService', () => {
    it('reports a valid startedAt alongside ok, project, and head', () => {
        const service = new HealthService(buildConfig('my-project'));

        const result = service.get();

        expect(result.ok).toBe(true);
        expect(result.project).toBe('my-project');
        expect(typeof result.head).toBe('string');
        expect(result.startedAt).toBeInstanceOf(DateTime);
        expect((result.startedAt as DateTime).isValid).toBe(true);
    });

    it('captures startedAt once at module load, not per call or per instance', async () => {
        const first = new HealthService(buildConfig()).get().startedAt as DateTime;

        // Give the wall clock a chance to move before asking again.
        await new Promise(resolve => setTimeout(resolve, 20));

        const second = new HealthService(buildConfig('a-different-project')).get().startedAt as DateTime;

        expect(second.toMillis()).toBe(first.toMillis());
    });

    it('reports the deployment roots from BoardConfig, not just the process facts', () => {
        // Card 0114: the settings page renders these as read-only deployment facts, sourced
        // straight from `/api/health`. Distinct values per root, rather than two copies of the
        // same string, catches a service that accidentally wires two of them to the same field.
        const config = new StaticBoardConfig('wilson', '/deploy/code', '/deploy/worktrees', '/run');

        const result = new HealthService(config).get();

        expect(result.codeRoot).toBe('/deploy/code');
        expect(result.worktreeRoot).toBe('/deploy/worktrees');
    });

    it('serializes startedAt to an ISO string over the wire, the shape daemonCurrent parses back', () => {
        // `health.router.ts` hands this result straight to koa as `ctx.body`, which JSON-serializes
        // it for the actual HTTP response — the router never runs it back through the generated zod
        // schema on the way out. `packages/cli/src/checks/daemon.current.ts` then reads the response
        // with `DateTime.fromISO(health.startedAt)`, so what actually crosses the wire has to be a
        // plain ISO string, not the `DateTime` instance this service returns in-process.
        const result = new HealthService(buildConfig()).get();

        const overTheWire = JSON.parse(JSON.stringify(result));

        expect(typeof overTheWire.startedAt).toBe('string');
        const roundTripped = DateTime.fromISO(overTheWire.startedAt);
        expect(roundTripped.isValid).toBe(true);
        expect(roundTripped.toMillis()).toBe((result.startedAt as DateTime).toMillis());
    });
});

/**
 * Card 0100. `commitsBehind` is `CardStageJob`'s in-process answer to "is the daemon stale, right
 * now, at the moment it is about to dispatch" — comparing this process's own commit (`buildHead`)
 * against the commit a card's worktree is about to be cut from, by ancestry rather than by time.
 * Exercises real git, like `WorktreeManager`'s own tests, because ancestry is exactly the thing worth
 * getting right here.
 */
describe('commitsBehind', () => {
    // Deliberately the first test in this file to touch `buildHead`/`captureBuildHead`: the capture
    // in build.info.ts is a one-time, process-lifetime cache that nothing resets, so this has to run
    // before any other test here calls `captureBuildHead` and gives the process a real commit.
    it('answers 0 without a stale daemon commit to compare against, before the process has captured its own', async () => {
        expect(await commitsBehind('/does/not/exist', 'deadbeef')).toBe(0);
    });

    describe('once the daemon has captured its own commit', () => {
        // `captureBuildHead` genuinely captures only once per process (build.info.ts's whole point —
        // nothing resets it), so every case below shares one repo and one capture rather than each
        // building its own: a second `captureBuildHead` call from a fresh test's own repo would be a
        // no-op returning the *first* test's commit, comparing shas from two unrelated histories.
        let codeRoot: string;
        let firstSha: string;
        let daemonCommit: string;
        let fourthSha: string;

        beforeAll(async () => {
            const base = await mkdtemp(join(tmpdir(), 'commits-behind-'));
            codeRoot = join(base, 'code');
            await mkdir(codeRoot, { recursive: true });

            await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
            await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
            await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });

            await writeFile(join(codeRoot, 'file.txt'), 'one\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'first'], { cwd: codeRoot });
            firstSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();

            await writeFile(join(codeRoot, 'file.txt'), 'two\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'second'], { cwd: codeRoot });

            // Captured once, at "boot" — everything committed after this point is what a daemon that
            // started here would not know about, exactly `captureBuildHead`'s own contract.
            daemonCommit = await captureBuildHead(codeRoot);

            await writeFile(join(codeRoot, 'file.txt'), 'three\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'third'], { cwd: codeRoot });
            await writeFile(join(codeRoot, 'file.txt'), 'four\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'fourth'], { cwd: codeRoot });
            fourthSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: codeRoot })).stdout.trim();
        });

        it('is 0 when ref is the commit the daemon is running — current', async () => {
            expect(await commitsBehind(codeRoot, daemonCommit)).toBe(0);
        });

        it("is 0 when ref is an ancestor of the daemon's own commit — the daemon is ahead, not stale", async () => {
            expect(await commitsBehind(codeRoot, firstSha)).toBe(0);
        });

        it('counts the commits ref is ahead by when the daemon is behind', async () => {
            expect(await commitsBehind(codeRoot, fourthSha)).toBe(2);
        });

        it('is 0 for a codeRoot that cannot answer the git question at all', async () => {
            expect(await commitsBehind('/does/not/exist', daemonCommit)).toBe(0);
        });
    });
});
