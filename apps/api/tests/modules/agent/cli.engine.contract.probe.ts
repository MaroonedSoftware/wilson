import { describe, expect, it, vi } from 'vitest';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliStageAgent, createToolGuard, subscriptionEnv } from '#modules/agent/cli.stage.agent.js';
import { REPORT_RESULT_PATH, ScopeGuard } from '#modules/agent/scope.guard.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { stepsExceeded } from '#modules/agent/budget.js';
import type { ToolContext } from '#modules/agent/tools/index.js';
import { describeProbeRun, describeTurns, DENIED_BASH_PROBE_STEPS, type AttemptedToolCall, type RecordedAssistantTurn } from './probe.report.js';

/**
 * Card 0255. `query()`'s own stream is the engine's ground truth for what it attempted — the guard
 * (`watchToolContext` below) only ever sees the subset it was consulted about, card 0252's own gap.
 * Wrapping the SDK's `query` export here, rather than instrumenting `CliStageAgent` itself (out of
 * scope — the plan's Constraints keep this probe-side only), means every assistant message it emits
 * is recorded before `CliStageAgent.run()`'s own import of `query` — the same module specifier, so
 * the same mock — ever sees it: `vi.mock` replaces the module for every importer in this file's graph,
 * this adapter's included. Every other export is re-exported from the real module untouched, and
 * every message this wraps is passed through unmodified — only the recording is new. `engineTurns`
 * is reset to a fresh array on each `query()` call, so a second run in the same test file starts
 * clean rather than accumulating the previous run's turns.
 */
const { engineTurns } = vi.hoisted(() => ({ engineTurns: { current: [] as RecordedAssistantTurn[] } }));

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => {
    const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
    return {
        ...actual,
        query: (...args: Parameters<typeof actual.query>) => {
            const real = actual.query(...args);
            const turns: RecordedAssistantTurn[] = [];
            engineTurns.current = turns;
            // A `Proxy` over the real `Query` rather than a fresh async generator, so methods like
            // `getContextUsage()` (which `CliStageAgent.run`'s own idle/context beat calls directly
            // on the stream) stay wired to the real engine. Only `Symbol.asyncIterator` is
            // overridden, to record each assistant message as it passes through — every other
            // property, bound to the real object, is untouched.
            return new Proxy(real, {
                get(target, prop, receiver) {
                    if (prop === Symbol.asyncIterator) {
                        return () =>
                            (async function* () {
                                for (;;) {
                                    const next = await target.next();
                                    if (next.done) return next.value;
                                    const message = next.value as { type: string; message?: { content?: unknown } };
                                    if (message.type === 'assistant') {
                                        turns.push({ content: (message.message?.content ?? []) as RecordedAssistantTurn['content'] });
                                    }
                                    yield next.value;
                                }
                            })();
                    }
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
});

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
 * This file is not named `*.test.ts` on purpose, so `apps/api/vitest.config.ts`'s default `include`
 * — and therefore the default `pnpm test` — never collects it at all: not a skip, a file the
 * default run does not see, per the Constraints. `apps/api/vitest.engine.config.ts` names this file
 * exactly, and `pnpm --filter @wilson/api test:engine` runs it through that config.
 *
 * Even under that command, all three `describe` blocks below stay gated behind
 * `WILSON_RUN_ENGINE_PROBES=1` — via vitest's own `describe.skipIf`, so the reporter says "skipped"
 * rather than reporting a green pass that never ran anything. Every probe here drives a real turn,
 * which spends real model turns against the operator's own credentials; the gate keeps that cost
 * opt-in even for someone who runs `test:engine` without reading this comment first. It is also why
 * turning it on inside a stage does not work: a stage *is* an engine, so a probe run from inside one
 * spawns a nested engine, and the nested one cannot authenticate (see the card's own Constraints for
 * the mechanism). Run these by hand instead, from a terminal that already has a working `claude`
 * session, with:
 *
 *     WILSON_RUN_ENGINE_PROBES=1 pnpm --filter @wilson/api test:engine
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

/**
 * A `ToolContext` built from the real `ScopeGuard`/`CommandAllowlist` — no mock of either.
 *
 * `events`, when given, receives every event `context.events.append` records — card 0248's
 * denied-bash probe below reads it back to prove `canUseTool` was actually consulted for the Bash
 * call, the same way `CliStageAgent.run` itself now tells a guarded call the guard saw from one it
 * never got a chance to.
 */
const buildContext = (
    root: string,
    allow: string[],
    commands: string[],
    events: { type: string; payload?: Record<string, unknown> }[] = [],
): ToolContext =>
    ({
        project: 'p',
        cardId: '0231',
        stage: 'implementing',
        worktreeRoot: root,
        scope: new ScopeGuard({ worktreeRoot: root, allow, alwaysAllowed: [] }),
        commands: new CommandAllowlist(commands),
        scopeViolationPolicy: 'widen',
        events: { append: async (e: { type: string; payload?: Record<string, unknown> }) => void events.push(e) },
        logger: silentLogger,
    }) as unknown as ToolContext;

/**
 * Card 0252. A `ToolContext` built the same way `buildContext` is, but with `scope`/`commands`
 * wrapped to record every attempted call, in order — the seam this file already uses to build the
 * context handed to `CliStageAgent.run()`. That adapter builds its own `canUseTool` internally from
 * this context (see `createToolGuard` in `cli.stage.agent.ts`), so nothing outside it can wrap
 * `canUseTool` itself the way `watchGuard` does for the raw `query()` probes above; `scope.checkRead`,
 * `scope.check` and `commands.check` are what `createToolGuard`'s own `decide()` calls for every tool
 * it is asked about, guarded or not — including a Read, Glob or Grep, which `decide()` allows without
 * ever appending an event. That is exactly the gap the "still reports cleanly..." probe's own failure
 * could not close: no events recorded says nothing about whether the model's steps went to a read or
 * to nothing at all. The label is coarser than the engine's own tool name — `checkRead` cannot say
 * whether the call came from Read, Glob or Grep, and `scope.check` cannot say Write from Edit —
 * because only `CliStageAgent.run()` itself sees the real tool name, and changing it is out of scope
 * for this card. A `checkRead` of `REPORT_RESULT_PATH` is labelled `report_result` rather than `read`:
 * it is the report tool's own handler reading back what it wrote, not the model reaching for Read.
 */
const watchToolContext = (
    root: string,
    allow: string[],
    commands: string[],
    events: { type: string; payload?: Record<string, unknown> }[] = [],
): { context: ToolContext; attempted: AttemptedToolCall[] } => {
    const attempted: AttemptedToolCall[] = [];
    const scope = new ScopeGuard({ worktreeRoot: root, allow, alwaysAllowed: [] });
    const commandAllowlist = new CommandAllowlist(commands);
    const context = {
        project: 'p',
        cardId: '0231',
        stage: 'implementing',
        worktreeRoot: root,
        scope: {
            checkRead: async (path: string) => {
                attempted.push({ tool: path === REPORT_RESULT_PATH ? 'report_result' : 'read', detail: path });
                return scope.checkRead(path);
            },
            check: async (path: string) => {
                attempted.push({ tool: 'write', detail: path });
                return scope.check(path);
            },
            grant: (path: string) => scope.grant(path),
            grants: () => scope.grants(),
            collateralHits: () => scope.collateralHits(),
        },
        commands: {
            check: (command: string) => {
                attempted.push({ tool: 'bash', detail: command });
                return commandAllowlist.check(command);
            },
        },
        scopeViolationPolicy: 'widen',
        events: { append: async (e: { type: string; payload?: Record<string, unknown> }) => void events.push(e) },
        logger: silentLogger,
    } as unknown as ToolContext;
    return { context, attempted };
};

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
            new Error(
                `engine ended this turn as '${message.subtype}'${message.is_error ? ' (is_error)' : ''} before the probed behaviour was ever observed`,
            ),
            { errorClass: 'probe_result_error' },
        );
    }
};

/**
 * Card 0252. Every `tool_use` block in one assistant message's content, as an `AttemptedToolCall` —
 * what the model attempted, independent of whether `canUseTool`/the guard was ever consulted for it.
 * That independence is the point for the "is never consulted at all" probe below: `allowedTools`
 * bypasses the guard entirely, so `watchGuard`'s own `calls` stays empty there whether or not the
 * model ever proposed the write, and only reading the stream's own `tool_use` blocks can tell those
 * two cases apart. Detail mirrors `cli.stage.agent.ts`'s own `guardedToolCalls` extraction: the
 * command for Bash, the path otherwise.
 */
const attemptedFromContent = (content: { type: string; name?: string; input?: unknown }[]): AttemptedToolCall[] =>
    content
        .filter((part): part is { type: 'tool_use'; name: string; input?: unknown } => part.type === 'tool_use')
        .map(part => {
            const input = (part.input ?? {}) as Record<string, unknown>;
            const detail = part.name === 'Bash' ? String(input.command ?? '') : String(input.file_path ?? input.path ?? '');
            return { tool: part.name, detail };
        });

/** Wraps a real `canUseTool` so every call and its resolved decision is recorded, without changing what it decides. */
const watchGuard = (raw: CanUseTool): { canUseTool: CanUseTool; calls: { toolName: string; result: PermissionResult | null }[] } => {
    const calls: { toolName: string; result: PermissionResult | null }[] = [];
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
        const result = await raw(toolName, input, opts);
        calls.push({ toolName, result });
        return result;
    };
    return { canUseTool, calls };
};

describe.skipIf(!RUN_ENGINE_PROBES)('a write outside scope really is checked by a live engine, through the guard this adapter exports', () => {
    it('consults canUseTool for a Write outside the declared scope and denies it, with nothing landing on disk', async () => {
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
    }, 60000);

    it(// The inversion: CliStageAgent.ts's own claim, measured rather than assumed — "with Write
    // allowed [as an allowedTools entry], a probe wrote a file outside the declared scope and
    // the guard was never called once." Reproduced here on purpose, so this file would catch a
    // regression back to that exact defect.
    'is never consulted at all — and the write actually lands — once allowedTools bypasses it, reproducing PROJECT.md’s own defect', async () => {
        const root = await buildFixture();
        const events: { type: string; payload?: Record<string, unknown> }[] = [];
        const context = buildContext(root, ['src/runner/**'], [], events);
        const { canUseTool, calls } = watchGuard(createToolGuard(context, 'rw'));
        const abortController = new AbortController();
        // Card 0252: collected independent of `calls` above — `allowedTools` bypasses the guard
        // entirely, so `calls` cannot tell "the model never attempted the write" from "the write
        // was attempted and something else about the engine changed". This is what can.
        const attempted: AttemptedToolCall[] = [];

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
                if (message.type === 'assistant') attempted.push(...attemptedFromContent(message.message.content));
                if (message.type === 'result') break;
            }
        } catch (err) {
            asEngineUnreachable(err);
        } finally {
            abortController.abort();
        }

        expect(
            calls.some(c => c.toolName === 'Write'),
            describeProbeRun({ attempted, events }),
        ).toBe(false);
        await expect(readFile(join(root, 'src', 'other', 'leak.txt'), 'utf8'), describeProbeRun({ attempted, events })).resolves.toBe('leak');
    }, 60000);
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
    it('invokes the handler when the model calls mcp__wilson__report_result', async () => {
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
    }, 60000);

    it(// Not vacuous: the flag above must actually distinguish "called" from "not called" — the
    // same reasoning cli.tool.surface.test.ts gives for proving its own decoy server is real.
    'leaves the handler unentered when the model is never asked to call it', async () => {
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
    }, 60000);
});

describe.skipIf(!RUN_ENGINE_PROBES)('a denied bash command does not spend a step, asked of a real engine', () => {
    /**
     * `cli.step.budget.test.ts` already covers this against a mocked SDK — see its own "does not
     * charge refused calls" case. What a live engine can add is that a *real* denied Bash call is
     * still routed through the same credit mechanism, not just a canned stream. Both runs below give
     * the model the same one instruction — call `true` once, then report — and differ only in
     * whether `true` is on the stage's allowlist. `REPORT_RESULT_PATH` is pre-written so a compliant
     * model needs three steps: the plan read every stage agent is told to do first, the bash call,
     * and the report call. Card 0253: `DENIED_BASH_PROBE_STEPS` is that count, not two — a tight
     * two-step budget left no step for the Bash call at all once the read was spent, which is what
     * made the denied run fail without ever reaching the guard (see that constant's own doc comment).
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
        maxSteps: DENIED_BASH_PROBE_STEPS,
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
        const events: { type: string; payload?: Record<string, unknown> }[] = [];
        // Card 0252: `watchToolContext` rather than `buildContext` — its `scope`/`commands` are
        // wrapped so `attempted` below carries every tool call the model attempted, in order, not
        // just the ones a guard consultation happened to record an event for.
        const { context, attempted } = watchToolContext(root, ['src/runner/**'], allowedCommands, events);
        const agent = new CliStageAgent(silentLogger as never);
        const output = (await agent.run({
            stage: makeStage(allowedCommands),
            context,
            planPath: join(root, 'plan.md'),
            title: 'probe',
            resultSchema,
            baseSha: 'HEAD',
        } as never)) as {
            truncated: boolean;
            result?: unknown;
            budgetFailure?: string;
            engineFailure?: string;
            engineStopReason?: string;
        };
        // Card 0255: the mocked `query()` above reset `engineTurns.current` to a fresh array for
        // this run's own call, so this is exactly the assistant messages this run's engine produced
        // — not a leftover from a previous run in this file.
        return { output, events, attempted, engineTurns: engineTurns.current };
    };

    it('still reports cleanly at a tight step budget when the one bash call is denied', async () => {
        const { output, events, attempted, engineTurns: turns } = await runReal([]);
        if (output.engineFailure) throw new Error(`engine unreachable: ${output.engineFailure}`);
        // Card 0255: `describeTurns` alongside `describeProbeRun` — the engine's own view of what
        // it attempted, beside the guard's view of what it was asked about. The gap between the
        // two is what a failure here needs to say, not just that the assertion did not hold.
        const message = `${describeProbeRun({ attempted, events, output })} | ${describeTurns(turns)}`;

        // Card 0248: on 2026-09-19, against this same host engine, this exact call — one denied
        // Bash command — ran without `canUseTool` ever being consulted for it: no `tool.denied`,
        // no `tool.executed`, nothing. `deny()` inside `createToolGuard` appends `tool.denied` for
        // Bash only when the guard was actually asked, so its presence here is direct evidence the
        // consultation happened this time — checked before the truncation assertions below, which
        // would pass the same way whether or not the guard was ever in the loop at all.
        expect(
            events.some(e => e.type === 'tool.denied' && (e.payload as { tool?: string } | undefined)?.tool === 'Bash'),
            message,
        ).toBe(true);

        // cli.stage.agent.ts: "Refused calls do not spend the budget... The ceiling grows by
        // one per refusal, so a run keeps its full allowance of productive steps."
        expect(output.truncated, message).toBe(false);
        expect(output.result, message).toEqual({ summary: 'ok' });
    }, 60000);

    it(// The inversion: the same budget, the same three steps, but nothing was ever refused — so
    // there is no credit to grow the ceiling, and it is exceeded. This is what proves the pass
    // above came from the credit, not from a budget that was generous enough regardless.
    'control: the same tight budget is exceeded when that one bash call is allowed instead of denied', async () => {
        const { output } = await runReal(['true']);
        if (output.engineFailure) throw new Error(`engine unreachable: ${output.engineFailure}`);

        expect(output.truncated).toBe(true);
        expect(output.budgetFailure).toBe(stepsExceeded(DENIED_BASH_PROBE_STEPS, 0));
    }, 60000);
});
