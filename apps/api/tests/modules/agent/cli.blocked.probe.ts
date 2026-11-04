import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CliStageAgent } from '#modules/agent/cli.stage.agent.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * What a real engine does when `report_blocked` stops the run right after the tool call, which a
 * mocked SDK cannot say: the handler's reply races the engine being torn down. Three things have to
 * hold. The run ends with the question, promptly. The engine does no more work, even told to. And
 * nothing rejects unhandled on the way down, since in the daemon that would be a process-level fault.
 *
 * A `*.probe.ts`, so the default `pnpm test` never collects it, and gated like
 * `cli.engine.contract.probe.ts`, because it spends real model turns. By hand, from a terminal with a
 * working `claude` session, with `WILSON_PROBE_ENGINE=path` for the `claude` on `PATH` a remote host
 * starts, and without it for the SDK's bundled engine a stage on this machine starts:
 *
 *     WILSON_RUN_ENGINE_PROBES=1 pnpm --filter @wilson/api test:engine cli.blocked.probe
 */
const RUN_ENGINE_PROBES = process.env.WILSON_RUN_ENGINE_PROBES === '1';

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => {
    const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
    return {
        ...actual,
        query: (...args: Parameters<typeof actual.query>) => {
            const [input] = args;
            return process.env.WILSON_PROBE_ENGINE === 'path'
                ? actual.query({ ...input, options: { ...input.options, pathToClaudeCodeExecutable: 'claude' } })
                : actual.query(input);
        },
    };
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AFTER_FILE = 'src/after-the-question.txt';

const stage = {
    name: 'implementing',
    mode: 'agent',
    worktree: 'rw',
    adapter: 'cli',
    provider: 'anthropic',
    model: process.env.WILSON_PROBE_MODEL ?? 'claude-haiku-5-5',
    instructions:
        'This is a test of a tool. Call mcp__wilson__report_blocked exactly once, right now, with category "decision", tried "nothing", ' +
        `question "Red or blue?". Then, straight after that call, use the Write tool to create ${AFTER_FILE} containing "after". ` +
        'Do not do anything else first.',
    allowedCommands: [],
    worktreeFrom: 'base',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 10,
    maxOutputTokens: 4000,
    maxInputTokens: 2_000_000,
    maxWallClockMs: 120_000,
    maxIdleMs: 60_000,
    maxContextWindowFraction: 0.9,
    onPass: 'review',
    onFail: 'implementing',
    maxKickbacks: 3,
};

describe.skipIf(!RUN_ENGINE_PROBES)('report_blocked on a real engine', () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);

    beforeAll(() => {
        process.on('unhandledRejection', onRejection);
    });
    afterAll(() => {
        process.off('unhandledRejection', onRejection);
    });

    it('ends the run with the question and no further work, and goes down cleanly', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cli-blocked-probe-'));
        await mkdir(join(root, 'src'), { recursive: true });
        await promisify(execFile)('git', ['init', '-q'], { cwd: root });

        const events: { type: string; payload?: Record<string, unknown> }[] = [];
        const context = {
            project: 'p',
            cardId: 'probe',
            stage: 'implementing',
            worktreeRoot: root,
            scope: new ScopeGuard({ worktreeRoot: root, allow: ['src/**'], alwaysAllowed: [] }),
            commands: new CommandAllowlist([]),
            scopeViolationPolicy: 'widen',
            events: { append: async (event: { type: string; payload?: Record<string, unknown> }) => void events.push(event) },
            logger: silentLogger,
        } as unknown as ToolContext;

        const startedAt = Date.now();
        const output = await new CliStageAgent(silentLogger as never).run({
            stage,
            context,
            planPath: join(root, 'plan.md'),
            title: 'probe',
            resultSchema: z.object({ summary: z.string() }),
            baseSha: 'HEAD',
        } as never);
        const tookMs = Date.now() - startedAt;

        console.log(
            JSON.stringify({
                blocked: output.blocked,
                usage: output.usage,
                truncated: output.truncated,
                engineFailure: output.engineFailure,
                tookMs,
            }),
        );
        expect(output.engineFailure, 'engine unreachable').toBeUndefined();
        expect(output.blocked).toMatchObject({ category: 'decision', question: 'Red or blue?' });
        expect(output.truncated).toBe(false);
        expect(output.usage?.inputTokens ?? 0).toBeGreaterThan(0);

        // Long enough for a turn after the tool call to have landed, had the engine lived to take one.
        await new Promise(resolve => setTimeout(resolve, 15_000));

        await expect(access(join(root, AFTER_FILE))).rejects.toThrow();
        expect(events.filter(event => event.type === 'tool.executed')).toEqual([]);
        expect(rejections).toEqual([]);
    }, 180_000);
});
