import { describe, expect, it } from 'vitest';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliStageAgent, createToolGuard, subscriptionEnv } from '#modules/agent/cli.stage.agent.js';
import { REPORT_RESULT_PATH, ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import type { ToolContext } from '#modules/agent/tools/index.js';

/**
 * Card 0231. `cli.tool.surface.test.ts` (card 0096) drives a real engine and reads the `init`
 * message, then aborts — proving the *shape* of the tool surface at zero cost, because it never lets
 * a turn run. It says so itself: that is deliberately as far as it goes.
 *
 * What it cannot prove is that the pieces `CliStageAgent` assembles around that surface still behave
 * the way its own doc comments claim once a real engine actually drives a turn through them — the
 * exact gap the card's own field survey found by hand: "with Write allowed [as an `allowedTools`
 * entry], the guard was never called once." A mock can only ever answer "does this adapter call the
 * function it thinks it calls"; it cannot answer "does the installed SDK still route things to that
 * function the way it did when this was written" — and every one of OpenCode's event drift, Gemini's
 * auth changes, and Claude Code's own `/pm` breakage (this card's Note) was exactly a wrapped CLI
 * changing what it does underneath an adapter that kept assuming the old behaviour.
 *
 * Three probes, each driving the minimum a real engine needs to exercise one behaviour, then
 * stopping: a write outside scope is refused *and* the guard that refused it is the same
 * `createToolGuard` this adapter exports and passes as `canUseTool` (not a second, hand-rolled
 * reimplementation of it); a `report_result` call actually reaches this adapter's in-process MCP
 * handler; a denied Bash call, driven through `CliStageAgent.run()` itself, still does not cost the
 * run a step. Each carries a companion that inverts the very thing being defended — the same
 * discipline `cli.tool.surface.test.ts` uses for its decoy server — so a probe that silently stopped
 * testing anything would fail loudly rather than pass by accident.
 *
 * Every assertion is on a mechanism a spy, a flag, or a returned value observed — never on the
 * model's prose, which the Constraints call a flake generator.
 *
 * All three `describe` blocks below are gated behind `WILSON_RUN_ENGINE_PROBES=1` and skipped —
 * via vitest's own `describe.skipIf`, so the reporter says "skipped" rather than reporting a green
 * pass that never ran anything — everywhere else. Every probe here drives a real turn, which spends
 * real model turns against the operator's own credentials; the gate exists so that cost is opt-in,
 * not something every `pnpm test` pays. It is also why turning it on inside a stage does not work:
 * a stage *is* an engine, so a probe run from inside one spawns a nested engine, and the nested one
 * cannot authenticate (see the card's own Constraints for the mechanism). Run these by hand instead,
 * from a terminal that already has a working `claude` session, with:
 *
 *     WILSON_RUN_ENGINE_PROBES=1 pnpm --filter @wilson/api test cli.engine.contract.test.ts
 *
 * Do this at an SDK or `claude` binary bump — exactly the moment `claudeBinaryCurrent`
 * (`packages/cli/src/checks/claude.binary.current.ts`) exists to announce, since with the gate off
 * by default nothing else catches drift on its own.
 */

const RUN_ENGINE_PROBES = process.env.WILSON_RUN_ENGINE_PROBES === '1';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** A throwaway worktree with one directory in scope and one out of it, for the scope probes below. */
const buildFixture = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'cli-engine-contract-'));
    await mkdir(join(root, 'src', 'runner'), { recursive: true });
    await mkdir(join(root, 'src', 'other'), { recursive: true });
    return root;
};

/** A `ToolContext` built from the real `ScopeGuard`/`CommandAllowlist` — no mock of either. */
const buildContext = (root: string, allow: string[], commands: string[]): ToolContext =>
    ({
        project: 'p',
        cardId: '0231',
        stage: 'implementing',
        worktreeRoot: root,
        scope: new ScopeGuard({ worktreeRoot: root, allow, alwaysAllowed: [] }),
        commands: new CommandAllowlist(commands),
        scopeViolationPolicy: 'widen',
        events: { append: async () => {} },
        logger: silentLogger,
    }) as unknown as ToolContext;

/**
 * An error the SDK's own process lifecycle tags with `errorClass` (per `cli.stage.agent.ts`'s own
 * catch block) means the engine itself never came up — no credentials, a rate limit, a network
 * failure — not that the behaviour under test failed. Rethrown with that named as the cause, so a
 * probe that never actually ran does not get reported as a behavioural mismatch.
 */
const asEngineUnreachable = (err: unknown): never => {
    const tagged = err as { message?: string; errorClass?: unknown };
    if (typeof tagged.errorClass === 'string') {
        throw new Error(`engine unreachable (${tagged.errorClass}): ${tagged.message ?? String(err)}`);
    }
    throw err;
};

/**
 * A `result` message the SDK itself marks unsuccessful — `is_error`, or a `subtype` other than
 * `'success'` — means this turn never actually completed, the same distinction
 * `cli.stage.agent.ts`'s own `describeEngineStop` exists to preserve rather than paper over. Thrown
 * rather than silently broken out of, so `asEngineUnreachable` (in the `catch` around every loop
 * below) gets a chance to name it as the cause instead of a later assertion reporting a behavioural
 * mismatch for a turn that never actually ran. A clean `result` — `subtype: 'success'`, no
 * `is_error` — is not thrown here even when the probed behaviour was never observed; that is a real
 * finding about the probe or the model's compliance, not an unreachable engine, and is left to the
 * caller's own assertions to report honestly.
 */
const throwOnFailedResult = (message: { type: string; subtype?: string; is_error?: boolean }): void => {
    if (message.type !== 'result') return;
    if (message.is_error || (message.subtype !== undefined && message.subtype !== 'success')) {
        throw Object.assign(
            new Error(`engine ended this turn as '${message.subtype}'${message.is_error ? ' (is_error)' : ''} before the probed behaviour was ever observed`),
            { errorClass: 'probe_result_error' },
        );
    }
};

/** Wraps a real `canUseTool` so every call and its resolved decision is recorded, without changing what it decides. */
const watchGuard = (raw: CanUseTool): { canUseTool: CanUseTool; calls: { toolName: string; result: PermissionResult }[] } => {
    const calls: { toolName: string; result: PermissionResult }[] = [];
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
        const result = await raw(toolName, input, opts);
        calls.push({ toolName, result });
        return result;
    };
    return { canUseTool, calls };
};

describe.skipIf(!RUN_ENGINE_PROBES)('a write outside scope really is checked by a live engine, through the guard this adapter exports', () => {
    it(
        'consults canUseTool for a Write outside the declared scope and denies it, with nothing landing on disk',
        async () => {
            const root = await buildFixture();
            const context = buildContext(root, ['src/runner/**'], []);
            const { canUseTool, calls } = watchGuard(createToolGuard(context, 'rw'));
            const abortController = new AbortController();

            try {
                const stream = query({
                    prompt: 'Call the Write tool right now to create the file "src/other/leak.txt" with the content "leak". Do not do anything else, and do not explain.',
                    options: {
                        cwd: root,
                        permissionMode: 'default',
                        settingSources: [],
                        strictMcpConfig: true,
                        canUseTool,
                        env: subscriptionEnv(),
                        mcpServers: {},
                        abortController,
                        maxTurns: 5,
                    },
                });
                for await (const message of stream) {
                    if (calls.some(c => c.toolName === 'Write')) break;
                    throwOnFailedResult(message);
                    if (message.type === 'result') break;
                }
            } catch (err) {
                asEngineUnreachable(err);
            } finally {
                abortController.abort();
            }

            const writeCall = calls.find(c => c.toolName === 'Write');
            // CliStageAgent.ts: "canUseTool is where they are put back: every Write, Edit and Bash
            // the engine proposes is checked against the same guards before it runs."
            expect(writeCall, 'the engine never proposed a Write — this probe tested nothing').toBeDefined();
            // scope.guard.ts: "a write outside scope fails at the tool and the diff can never
            // contain one in the first place."
            expect(writeCall!.result).toMatchObject({ behavior: 'deny' });
            await expect(readFile(join(root, 'src', 'other', 'leak.txt'), 'utf8')).rejects.toThrow();
        },
        60000,
    );

    it(
        // The inversion: CliStageAgent.ts's own claim, measured rather than assumed — "with Write
        // allowed [as an allowedTools entry], a probe wrote a file outside the declared scope and
        // the guard was never called once." Reproduced here on purpose, so this file would catch a
        // regression back to that exact defect.
        'is never consulted at all — and the write actually lands — once allowedTools bypasses it, reproducing PROJECT.md’s own defect',
        async () => {
            const root = await buildFixture();
            const context = buildContext(root, ['src/runner/**'], []);
            const { canUseTool, calls } = watchGuard(createToolGuard(context, 'rw'));
            const abortController = new AbortController();

            try {
                const stream = query({
                    prompt: 'Call the Write tool right now to create the file "src/other/leak.txt" with the content "leak". Do not do anything else, and do not explain.',
                    options: {
                        cwd: root,
                        permissionMode: 'default',
                        settingSources: [],
                        strictMcpConfig: true,
                        allowedTools: ['Write'],
                        canUseTool,
                        env: subscriptionEnv(),
                        mcpServers: {},
                        abortController,
                        maxTurns: 5,
                    },
                });
                for await (const message of stream) {
                    throwOnFailedResult(message);
                    if (message.type === 'result') break;
                }
            } catch (err) {
                asEngineUnreachable(err);
            } finally {
                abortController.abort();
            }

            expect(calls.some(c => c.toolName === 'Write')).toBe(false);
            await expect(readFile(join(root, 'src', 'other', 'leak.txt'), 'utf8')).resolves.toBe('leak');
        },
        60000,
    );
});

/** The same three tools `CliStageAgent` registers on its `wilson` MCP server, standing in for it. */
const wilsonServer = (reportHandler: (input: { path?: string }) => Promise<{ content: { type: 'text'; text: string }[] }>) =>
    createSdkMcpServer({
        name: 'wilson',
        tools: [
            tool('report_result', 'report the result', z.object({ path: z.string().optional() }).shape, reportHandler),
            tool('request_scope', 'request scope', z.object({ path: z.string(), reason: z.string() }).shape, async () => ({
                content: [{ type: 'text' as const, text: 'ok' }],
            })),
            tool('delete', 'delete a file', z.object({ path: z.string() }).shape, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
        ],
        alwaysLoad: true,
    });

describe.skipIf(!RUN_ENGINE_PROBES)('a report_result call really reaches this adapter’s in-process MCP handler', () => {
    it(
        'invokes the handler when the model calls mcp__wilson__report_result',
        async () => {
            const root = await buildFixture();
            let handlerRan = false;
            const server = wilsonServer(async () => {
                handlerRan = true;
                return { content: [{ type: 'text' as const, text: 'reported' }] };
            });
            const context = buildContext(root, ['src/runner/**'], []);
            const canUseTool = createToolGuard(context, 'rw');
            const abortController = new AbortController();

            try {
                const stream = query({
                    prompt: 'Call the mcp__wilson__report_result tool right now, with no arguments. Do not do anything else, and do not explain.',
                    options: {
                        cwd: root,
                        permissionMode: 'default',
                        settingSources: [],
                        strictMcpConfig: true,
                        canUseTool,
                        env: subscriptionEnv(),
                        mcpServers: { wilson: server },
                        abortController,
                        maxTurns: 5,
                    },
                });
                for await (const message of stream) {
                    if (handlerRan) break;
                    throwOnFailedResult(message);
                    if (message.type === 'result') break;
                }
            } catch (err) {
                asEngineUnreachable(err);
            } finally {
                abortController.abort();
            }

            // CliStageAgent.ts: "The engine has no equivalent of the api adapter's report tool, so
            // one is supplied as an in-process MCP server." This is that server, actually reached.
            expect(handlerRan).toBe(true);
        },
        60000,
    );

    it(
        // Not vacuous: the flag above must actually distinguish "called" from "not called" — the
        // same reasoning cli.tool.surface.test.ts gives for proving its own decoy server is real.
        'leaves the handler unentered when the model is never asked to call it',
        async () => {
            const root = await buildFixture();
            let handlerRan = false;
            const server = wilsonServer(async () => {
                handlerRan = true;
                return { content: [{ type: 'text' as const, text: 'reported' }] };
            });
            const context = buildContext(root, ['src/runner/**'], []);
            const canUseTool = createToolGuard(context, 'rw');
            const abortController = new AbortController();

            try {
                const stream = query({
                    prompt: 'Do not call any tool. Just reply with the single word "hi".',
                    options: {
                        cwd: root,
                        permissionMode: 'default',
                        settingSources: [],
                        strictMcpConfig: true,
                        canUseTool,
                        env: subscriptionEnv(),
                        mcpServers: { wilson: server },
                        abortController,
                        maxTurns: 5,
                    },
                });
                for await (const message of stream) {
                    throwOnFailedResult(message);
                    if (message.type === 'result') break;
                }
            } catch (err) {
                asEngineUnreachable(err);
            } finally {
                abortController.abort();
            }

            expect(handlerRan).toBe(false);
        },
        60000,
    );
});

describe.skipIf(!RUN_ENGINE_PROBES)('a denied bash command does not spend a step, asked of a real engine', () => {
    /**
     * `cli.step.budget.test.ts` already covers this against a mocked SDK — see its own "does not
     * charge refused calls" case. What a live engine can add is that a *real* denied Bash call is
     * still routed through the same credit mechanism, not just a canned stream. Both runs below give
     * the model the same one instruction — call `true` once, then report — and differ only in
     * whether `true` is on the stage's allowlist. `REPORT_RESULT_PATH` is pre-written so the only
     * two steps a compliant model needs are the bash call and the report call, keeping the step
     * count small enough that the credit's effect is actually observable at maxSteps: 2.
     */
    const resultSchema = z.object({ summary: z.string() });

    const makeStage = (allowedCommands: string[]) => ({
        name: 'implementing',
        mode: 'agent',
        worktree: 'rw',
        adapter: 'cli',
        provider: 'anthropic',
        model: 'claude-opus',
        instructions:
            'Call the bash tool with exactly the command `true`, once. Whether it succeeds or is refused, immediately ' +
            'afterwards call mcp__wilson__report_result with no arguments to finish. Do not call any other tool, do not ' +
            'write any files, and do not retry the bash call.',
        allowedCommands,
        worktreeFrom: 'base',
        extraScope: [],
        baselineCheck: true,
        maxSteps: 2,
        maxOutputTokens: 16000,
        maxInputTokens: 2_000_000,
        maxWallClockMs: 120_000,
        maxIdleMs: 60_000,
        maxContextWindowFraction: 0.9,
        onPass: 'review',
        onFail: 'implementing',
        maxKickbacks: 3,
    });

    /**
     * `CliStageAgent.run()` has no field for "the SDK marked this result unsuccessful" unless it
     * threw an error tagged with `errorClass` — a `result` message with `is_error: true` but
     * `subtype: 'success'` (a real shape this file's own debugging turned up) reads to `run()` as an
     * ordinary clean ending, the same ambiguity `throwOnFailedResult` exists to resolve for the raw
     * probes above. Rather than teach `run()` a new failure mode on the strength of one probe's
     * output, this does the same trivial one-message round trip those probes do, first — so an
     * unreachable engine is named as the cause here too, before it has a chance to be misread as
     * `runReal`'s own result never having been reported.
     */
    const assertEngineReachable = async (root: string): Promise<void> => {
        const abortController = new AbortController();
        try {
            const stream = query({
                prompt: 'Reply with the single word "hi". Do not call any tool.',
                options: {
                    cwd: root,
                    permissionMode: 'default',
                    settingSources: [],
                    strictMcpConfig: true,
                    env: subscriptionEnv(),
                    mcpServers: {},
                    abortController,
                    maxTurns: 2,
                },
            });
            for await (const message of stream) {
                throwOnFailedResult(message);
                if (message.type === 'result') break;
            }
        } catch (err) {
            asEngineUnreachable(err);
        } finally {
            abortController.abort();
        }
    };

    const runReal = async (allowedCommands: string[]) => {
        const root = await buildFixture();
        await assertEngineReachable(root);
        await writeFile(join(root, REPORT_RESULT_PATH), JSON.stringify({ summary: 'ok' }), 'utf8');
        const context = buildContext(root, ['src/runner/**'], allowedCommands);
        const agent = new CliStageAgent(silentLogger as never);
        return agent.run({
            stage: makeStage(allowedCommands),
            context,
            planPath: join(root, 'plan.md'),
            title: 'probe',
            resultSchema,
            baseSha: 'HEAD',
        } as never) as Promise<{ truncated: boolean; result?: unknown; budgetFailure?: string; engineFailure?: string }>;
    };

    it(
        'still reports cleanly at a tight step budget when the one bash call is denied',
        async () => {
            const output = await runReal([]);
            if (output.engineFailure) throw new Error(`engine unreachable: ${output.engineFailure}`);

            // cli.stage.agent.ts: "Refused calls do not spend the budget... The ceiling grows by
            // one per refusal, so a run keeps its full allowance of productive steps."
            expect(output.truncated).toBe(false);
            expect(output.result).toEqual({ summary: 'ok' });
        },
        60000,
    );

    it(
        // The inversion: the same budget, the same two steps, but nothing was ever refused — so
        // there is no credit to grow the ceiling, and it is exceeded. This is what proves the pass
        // above came from the credit, not from a budget that was generous enough regardless.
        'control: the same tight budget is exceeded when that one bash call is allowed instead of denied',
        async () => {
            const output = await runReal(['true']);
            if (output.engineFailure) throw new Error(`engine unreachable: ${output.engineFailure}`);

            expect(output.truncated).toBe(true);
            expect(output.budgetFailure).toBe('step budget exceeded: 2 steps');
        },
        60000,
    );
});
