import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CodexStageAgent, unwrapShell } from '#modules/agent/codex.stage.agent.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { StageInterrupt } from '#modules/agent/stage.interrupt.js';
import { localHost } from '#modules/host/local.execution.host.js';
import { ScopeKickbackError, type ToolContext } from '#modules/agent/tools/index.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { SimulatedCodexServer } from '#tests/support/simulated.codex.server.js';

/**
 * Against a simulated app-server, so this says what the adapter does with the protocol as documented.
 * Whether a real engine asks before every call is `codex.engine.contract.probe.ts`'s question.
 */
const logger = { info: () => {}, warn: vi.fn(), error: () => {}, debug: () => {} };
const resultSchema = z.object({ summary: z.string() });

describe('CodexStageAgent', () => {
    let root: string;
    let events: { type: string; payload?: Record<string, unknown> }[];
    const eventsOf = (type: string) => events.filter(event => event.type === type).map(event => event.payload ?? {});

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'codex-stage-'));
        events = [];
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const stage = (over: Partial<StageConfig> = {}) =>
        ({
            name: 'implementing',
            worktree: 'rw',
            isolated: true,
            model: 'gpt-test',
            instructions: 'Do the work.',
            maxSteps: 20,
            maxWallClockMs: 60_000,
            maxIdleMs: 30_000,
            maxInputTokens: 1_000_000,
            maxContextWindowFraction: 0.9,
            ...over,
        }) as unknown as StageConfig;

    const run = async (
        server: SimulatedCodexServer,
        {
            stageOver,
            policy = 'widen',
            resume,
            interrupts,
            spawn,
        }: {
            stageOver?: Partial<StageConfig>;
            policy?: 'widen' | 'kickback';
            resume?: { sessionId?: string };
            interrupts?: StageInterrupt;
            spawn?: () => unknown;
        } = {},
    ) => {
        const spawnCodex = vi.fn(spawn ?? (() => server.process));
        const context = {
            project: 'p',
            cardId: '0001',
            stage: 'implementing',
            worktreeRoot: root,
            scope: new ScopeGuard({ worktreeRoot: root, allow: ['src/**'], alwaysAllowed: [] }),
            commands: new CommandAllowlist(['pnpm test']),
            scopeViolationPolicy: policy,
            events: {
                append: async (event: { type: string; payload?: Record<string, unknown> }) => {
                    events.push(event);
                },
            },
            logger,
            host: {
                ...localHost,
                name: 'isolated',
                unlink: localHost.unlink.bind(localHost),
                removeTree: localHost.removeTree.bind(localHost),
                realpath: localHost.realpath.bind(localHost),
                spawnCodex,
            },
        } as unknown as ToolContext;
        const agent = new CodexStageAgent(logger as never, interrupts);
        const output = await agent.run({
            stage: stage(stageOver),
            context,
            planPath: '/plans/plan.md',
            title: 'A card',
            resultSchema,
            baseSha: 'abc123',
            ...(resume && { resume }),
        });
        return { output, spawnCodex };
    };

    const startOf = (server: SimulatedCodexServer, method: string) => server.received.find(request => request.method === method)?.params ?? {};
    const report = (server: SimulatedCodexServer) => server.callTool('report_result', { summary: 'done' });

    describe('before it starts', () => {
        it('refuses a stage not marked isolated, without starting an engine', async () => {
            const server = new SimulatedCodexServer();
            const { output, spawnCodex } = await run(server, { stageOver: { isolated: false } });

            expect(output.engineFailure).toMatch(/must be marked isolated/);
            expect(spawnCodex).not.toHaveBeenCalled();
        });

        it('refuses on a host that cannot start the engine', async () => {
            const context = { project: 'p', cardId: '1', stage: 's', worktreeRoot: root, host: { name: 'old-worker' } } as unknown as ToolContext;
            const output = await new CodexStageAgent(logger as never).run({
                stage: stage(),
                context,
                planPath: '/p',
                title: 't',
                resultSchema,
                baseSha: 'a',
            });

            expect(output.engineFailure).toBe('host "old-worker" cannot start the codex engine');
        });

        it('starts codex app-server in the worktree, with no Claude credential in its environment', async () => {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'secret-claude-token';
            process.env.CLAUDE_CONFIG_DIR = '/claude';
            try {
                const { spawnCodex } = await run(new SimulatedCodexServer(report));
                const options = spawnCodex.mock.calls[0]![0 as never] as unknown as {
                    command: string;
                    args: string[];
                    cwd: string;
                    env: NodeJS.ProcessEnv;
                };

                expect(options).toMatchObject({ command: 'codex', args: ['app-server'], cwd: root });
                expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
                expect(options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
                expect(options.env.PATH).toBeDefined();
            } finally {
                delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
                delete process.env.CLAUDE_CONFIG_DIR;
            }
        });
    });

    describe('what it asks the engine for', () => {
        it('has every approval come here, and never lets a subagent decide', async () => {
            const server = new SimulatedCodexServer(report);
            await run(server);

            expect(startOf(server, 'initialize')).toMatchObject({ capabilities: { experimentalApi: true } });
            for (const method of ['thread/start', 'turn/start']) {
                expect(startOf(server, method)).toMatchObject({ approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
            }
        });

        it('bounds a writing stage to its worktree with no network by default', async () => {
            const server = new SimulatedCodexServer(report);
            await run(server);

            expect(startOf(server, 'thread/start')).toMatchObject({ cwd: root, model: 'gpt-test', sandbox: 'workspace-write' });
            expect(startOf(server, 'turn/start').sandboxPolicy).toMatchObject({
                type: 'workspaceWrite',
                writableRoots: [root],
                networkAccess: false,
            });
        });

        it('gives a read-only stage a read-only sandbox and no request_scope', async () => {
            const server = new SimulatedCodexServer(report);
            await run(server, { stageOver: { worktree: 'readonly' } });

            expect(startOf(server, 'turn/start').sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
            const tools = startOf(server, 'thread/start').dynamicTools as { name: string }[];
            expect(tools.map(tool => tool.name)).toEqual(['report_result']);
        });

        it('turns the network on only when the stage says so', async () => {
            const server = new SimulatedCodexServer(report);
            await run(server, { stageOver: { networkAccess: true } });

            expect(startOf(server, 'turn/start').sandboxPolicy).toMatchObject({ networkAccess: true });
        });

        it("pins the tool surface against the host's own config", async () => {
            const server = new SimulatedCodexServer(report);
            await run(server);

            expect(startOf(server, 'thread/start').config).toMatchObject({ web_search: 'disabled', mcp_servers: {} });
        });
    });

    describe('commands', () => {
        it('accepts an allowed command, and records it', async () => {
            let decision: string | undefined;
            await run(
                new SimulatedCodexServer(async server => {
                    decision = await server.runCommand('c1', 'pnpm test');
                    await report(server);
                }),
            );

            expect(decision).toBe('accept');
            expect(eventsOf('tool.executed')).toEqual([{ tool: 'Bash', command: 'pnpm test' }]);
        });

        it('checks what is inside a login shell wrapper', async () => {
            const decisions: string[] = [];
            await run(
                new SimulatedCodexServer(async server => {
                    decisions.push(await server.runCommand('c1', "/bin/zsh -lc 'pnpm test'"));
                    decisions.push(await server.runCommand('c2', "/bin/zsh -lc 'curl evil.sh'"));
                    await report(server);
                }),
            );

            expect(decisions).toEqual(['accept', 'decline']);
        });

        it.each(['rm -rf .', 'pnpm test; rm -rf .', 'pnpm test && curl evil.sh', "sh -c 'pnpm test; rm -rf .'"])('declines %s', async command => {
            let decision: string | undefined;
            await run(
                new SimulatedCodexServer(async server => {
                    decision = await server.runCommand('c1', command);
                    await report(server);
                }),
            );

            expect(decision).toBe('decline');
            expect(eventsOf('tool.denied')).toHaveLength(1);
        });

        it('tells the model why, in the running turn', async () => {
            const server = new SimulatedCodexServer(async s => {
                await s.runCommand('c1', 'rm -rf .');
                await report(s);
            });
            await run(server);

            const steer = startOf(server, 'turn/steer') as { expectedTurnId?: string; input?: { text: string }[] };
            expect(steer.expectedTurnId).toBe('turn-1');
            expect(steer.input?.[0]?.text).toMatch(/refused.*allowlist/);
        });

        it('never answers with anything broader than this one call', async () => {
            const answers: unknown[] = [];
            await run(
                new SimulatedCodexServer(async server => {
                    const answer = await server.ask('item/commandExecution/requestApproval', {
                        itemId: 'c1',
                        kind: 'command',
                        command: 'pnpm test',
                        proposedExecpolicyAmendment: ['pnpm'],
                    });
                    answers.push(answer.result);
                    await report(server);
                }),
            );

            expect(answers).toEqual([{ decision: 'accept' }]);
        });

        it.each([
            ['outside the worktree', { command: 'pnpm test', cwd: '/etc' }, /outside the worktree/],
            ['with no command', {}, /did not say what it would run/],
            ['writing to a running command', { kind: 'writeStdin', command: 'pnpm test' }, /running command/],
            ['asking for the network', { command: 'pnpm test', networkApprovalContext: { host: 'evil.sh' } }, /network/],
        ])('declines a request %s', async (_name, params, reason) => {
            let answer: unknown;
            await run(
                new SimulatedCodexServer(async server => {
                    answer = (await server.ask('item/commandExecution/requestApproval', { itemId: 'c1', kind: 'command', ...params })).result;
                    await report(server);
                }),
            );

            expect(answer).toEqual({ decision: 'decline' });
            expect(JSON.stringify(eventsOf('tool.denied'))).toMatch(reason);
        });
    });

    describe('file changes', () => {
        const scripted = async (changes: { path: string; kind?: unknown }[], stageOver?: Partial<StageConfig>) => {
            let decision: string | undefined;
            const server = new SimulatedCodexServer(async s => {
                decision = await s.changeFiles('f1', changes);
                await report(s);
            });
            await run(server, { stageOver });
            return decision;
        };

        it('accepts a change in scope, and records it', async () => {
            expect(await scripted([{ path: join(root, 'src/a.ts') }])).toBe('accept');
            expect(eventsOf('tool.executed')).toEqual([{ tool: 'Write', path: 'src/a.ts' }]);
        });

        it('declines one outside scope', async () => {
            expect(await scripted([{ path: 'docs/a.md' }])).toBe('decline');
        });

        it('declines one outside the worktree', async () => {
            expect(await scripted([{ path: '/etc/passwd' }])).toBe('decline');
        });

        it('checks a deletion like any other change', async () => {
            expect(await scripted([{ path: 'docs/a.md', kind: { type: 'delete' } }])).toBe('decline');
            expect(await scripted([{ path: 'src/a.ts', kind: { type: 'delete' } }])).toBe('accept');
        });

        it('checks where a move ends up', async () => {
            expect(await scripted([{ path: 'src/a.ts', kind: { type: 'update', move_path: 'docs/a.ts' } }])).toBe('decline');
        });

        it('declines a whole patch for one bad path, recording nothing as written', async () => {
            expect(await scripted([{ path: 'src/a.ts' }, { path: 'docs/a.md' }])).toBe('decline');
            expect(eventsOf('tool.executed')).toEqual([]);
            expect(eventsOf('tool.denied').map(denied => denied.path)).toEqual(['docs/a.md']);
        });

        it('declines every write in a read-only stage, except scratch', async () => {
            expect(await scripted([{ path: 'src/a.ts' }], { worktree: 'readonly' })).toBe('decline');
            expect(await scripted([{ path: '.wilson-scratch/out.txt' }], { worktree: 'readonly' })).toBe('accept');
        });

        it('judges a patch by its latest update', async () => {
            let answer: unknown;
            await run(
                new SimulatedCodexServer(async server => {
                    server.notify('item/started', { item: { type: 'fileChange', id: 'f1', changes: [] } });
                    server.notify('item/fileChange/patchUpdated', { itemId: 'f1', changes: [{ path: 'docs/a.md' }] });
                    answer = (await server.ask('item/fileChange/requestApproval', { itemId: 'f1' })).result;
                    await report(server);
                }),
            );

            expect(answer).toEqual({ decision: 'decline' });
        });

        it('records a patch that touched more than was approved', async () => {
            await run(
                new SimulatedCodexServer(async server => {
                    server.notify('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'src/a.ts' }] } });
                    await server.ask('item/fileChange/requestApproval', { itemId: 'f1' });
                    server.notify('item/completed', {
                        item: { type: 'fileChange', id: 'f1', changes: [{ path: 'src/a.ts' }, { path: 'docs/a.md' }], status: 'completed' },
                    });
                    await new Promise(resolve => setImmediate(resolve));
                    await report(server);
                }),
            );

            expect(eventsOf('tool.unguarded')).toEqual([{ tool: 'Write', path: 'docs/a.md' }]);
        });

        it('declines a change it was never shown', async () => {
            let answer: unknown;
            await run(
                new SimulatedCodexServer(async server => {
                    answer = (await server.ask('item/fileChange/requestApproval', { itemId: 'never-started' })).result;
                    await report(server);
                }),
            );

            expect(answer).toEqual({ decision: 'decline' });
        });

        it('declines a request to keep a directory writable', async () => {
            let answer: unknown;
            await run(
                new SimulatedCodexServer(async server => {
                    server.notify('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'src/a.ts' }] } });
                    answer = (await server.ask('item/fileChange/requestApproval', { itemId: 'f1', grantRoot: '/' })).result;
                    await report(server);
                }),
            );

            expect(answer).toEqual({ decision: 'decline' });
        });
    });

    describe('requests a stage has no one to ask about', () => {
        it.each([
            'item/permissions/requestApproval',
            'item/tool/requestUserInput',
            'account/chatgptAuthTokens/refresh',
            'execCommandApproval',
            'applyPatchApproval',
        ])('answers %s with an error, granting nothing', async method => {
            let answer: { result?: unknown; error?: unknown } | undefined;
            await run(
                new SimulatedCodexServer(async server => {
                    answer = await server.ask(method, { itemId: 'x' });
                    await report(server);
                }),
            );

            expect(answer?.result).toBeUndefined();
            expect(answer?.error).toBeDefined();
        });
    });

    describe('calls the guard never saw', () => {
        it('records a command and a change that ran without asking', async () => {
            await run(
                new SimulatedCodexServer(async server => {
                    server.notify('item/completed', {
                        item: { type: 'commandExecution', id: 'c1', command: 'cat /etc/passwd', status: 'completed' },
                    });
                    server.notify('item/completed', {
                        item: { type: 'fileChange', id: 'f1', changes: [{ path: 'docs/a.md' }], status: 'completed' },
                    });
                    server.notify('item/completed', { item: { type: 'webSearch', id: 'w1' } });
                    await new Promise(resolve => setImmediate(resolve));
                    await report(server);
                }),
            );

            expect(eventsOf('tool.unguarded')).toEqual([
                { tool: 'Bash', command: 'cat /etc/passwd' },
                { tool: 'Write', path: 'docs/a.md' },
                { tool: 'webSearch' },
            ]);
        });

        it('does not count one that asked', async () => {
            await run(
                new SimulatedCodexServer(async server => {
                    await server.runCommand('c1', 'pnpm test');
                    await new Promise(resolve => setImmediate(resolve));
                    await report(server);
                }),
            );

            expect(eventsOf('tool.unguarded')).toEqual([]);
        });
    });

    describe('reporting', () => {
        it('ends the stage the moment a valid result is reported, with no edit after it', async () => {
            const server = new SimulatedCodexServer(async s => {
                await report(s);
                // The turn never completing is the point: nothing waits for it.
            });
            const { output } = await run(server);

            expect(output).toMatchObject({ result: { summary: 'done' }, truncated: false });
            expect(server.killed).toBe(true);
        });

        it('refuses a result that does not match, and lets the model try again', async () => {
            let first: { text?: string; success?: boolean } | undefined;
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    first = await server.callTool('report_result', { wrong: true });
                    await report(server);
                }),
            );

            expect(first?.success).toBe(false);
            expect(first?.text).toMatch(/does not match/);
            expect(output.result).toEqual({ summary: 'done' });
        });

        it('says when the turn ended with nothing reported', async () => {
            const { output } = await run(new SimulatedCodexServer(async server => server.completeTurn()));

            expect(output).toMatchObject({ truncated: false, engineStopReason: "ended as 'completed'" });
            expect(output.result).toBeUndefined();
            expect(eventsOf('turn.empty')).toHaveLength(1);
        });

        it('tells a dropped report from one never made', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    await server.callTool('report_result', { wrong: true });
                    server.completeTurn();
                }),
            );

            expect(output.resultDropped).toBe(true);
        });

        it('offers the result schema to the model', async () => {
            const server = new SimulatedCodexServer(report);
            await run(server);

            const tools = startOf(server, 'thread/start').dynamicTools as { name: string; inputSchema: Record<string, unknown> }[];
            expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['summary'] });
            expect(tools[0]?.inputSchema.$schema).toBeUndefined();
        });
    });

    describe('request_scope', () => {
        it('widens scope for a later change', async () => {
            let decision: string | undefined;
            await run(
                new SimulatedCodexServer(async server => {
                    await server.callTool('request_scope', { path: 'docs/a.md', reason: 'needed' });
                    decision = await server.changeFiles('f1', [{ path: 'docs/a.md' }]);
                    await report(server);
                }),
            );

            expect(decision).toBe('accept');
            expect(eventsOf('scope.requested')).toEqual([{ path: 'docs/a.md', reason: 'needed' }]);
        });

        it('stops the stage under the kickback policy', async () => {
            await expect(
                run(
                    new SimulatedCodexServer(async server => void (await server.callTool('request_scope', { path: 'docs/a.md', reason: 'needed' }))),
                    { policy: 'kickback' },
                ),
            ).rejects.toBeInstanceOf(ScopeKickbackError);
        });

        it('is not available to a read-only stage', async () => {
            let answer: { text?: string; success?: boolean } | undefined;
            await run(
                new SimulatedCodexServer(async server => {
                    answer = await server.callTool('request_scope', { path: 'docs/a.md', reason: 'needed' });
                    await report(server);
                }),
                { stageOver: { worktree: 'readonly' } },
            );

            expect(answer?.success).toBe(false);
        });
    });

    describe('budgets', () => {
        it('stops at its step budget, not charging refused calls', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    for (let call = 0; call < 10; call++) await server.runCommand(`c${call}`, call === 0 ? 'rm -rf .' : 'pnpm test');
                }),
                { stageOver: { maxSteps: 3 } },
            );

            expect(output.truncated).toBe(true);
            expect(output.budgetFailure).toMatch(/1 refused/);
        });

        it('lets a stage on its last step report', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    await server.runCommand('c1', 'pnpm test');
                    await report(server);
                }),
                { stageOver: { maxSteps: 2 } },
            );

            expect(output).toMatchObject({ result: { summary: 'done' }, truncated: false });
            expect(output.budgetFailure).toBeUndefined();
        });

        it('stops at its input token budget, counting what was cached', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    server.notify('thread/tokenUsage/updated', {
                        tokenUsage: {
                            total: { inputTokens: 900, cachedInputTokens: 800, outputTokens: 5 },
                            last: { inputTokens: 1 },
                            modelContextWindow: null,
                        },
                    });
                }),
                { stageOver: { maxInputTokens: 900 } },
            );

            expect(output.usage).toEqual({ inputTokens: 100, cachedInputTokens: 800, outputTokens: 5 });
            expect(output.budgetFailure).toMatch(/900/);
        });

        it('stops when the context window is nearly full', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    server.notify('thread/tokenUsage/updated', {
                        tokenUsage: {
                            total: { inputTokens: 95, cachedInputTokens: 0, outputTokens: 5 },
                            last: { inputTokens: 95 },
                            modelContextWindow: 100,
                        },
                    });
                }),
            );

            expect(output.budgetFailure).toMatch(/context window budget exceeded/);
        });

        it('stops at its wall clock', async () => {
            const { output } = await run(new SimulatedCodexServer(async () => {}), { stageOver: { maxWallClockMs: 20, maxIdleMs: 20 } });

            expect(output).toMatchObject({ truncated: true, budgetFailure: 'wall-clock budget exceeded: cap 20ms' });
        });

        it('does not take an engine retrying for one making progress', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    const retrying = setInterval(() => server.notify('error', { error: { message: 'stream disconnected' }, willRetry: true }), 5);
                    await new Promise(resolve => setTimeout(resolve, 60));
                    clearInterval(retrying);
                }),
                { stageOver: { maxIdleMs: 20 } },
            );

            expect(output.engineFailure).toMatch(/its last error: stream disconnected/);
        });

        it('calls a silent engine silent', async () => {
            const { output } = await run(new SimulatedCodexServer(async () => {}), { stageOver: { maxIdleMs: 20 } });

            expect(output.engineFailure).toMatch(/20/);
            expect(output.budgetFailure).toBeUndefined();
        });
    });

    describe('when the engine fails', () => {
        it('reports a failed turn in its own words, with what kind of failure', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server =>
                    server.completeTurn('failed', { message: 'you hit your limit', codexErrorInfo: 'usageLimitExceeded' }),
                ),
            );

            expect(output.engineFailure).toMatch(/you hit your limit \(usageLimitExceeded\)/);
            expect(output.engineStopReason).toBe("ended as 'failed'");
            expect(eventsOf('engine.failed')).toHaveLength(1);
        });

        it('reports the process exiting, with its stderr', async () => {
            const { output } = await run(
                new SimulatedCodexServer(async server => {
                    server.stderr.write('panic: out of cheese');
                    await new Promise(resolve => setImmediate(resolve));
                    server.exit(101);
                }),
            );

            expect(output.engineFailure).toMatch(/exit code 101.*out of cheese/s);
            expect(eventsOf('engine.failed')[0]).toMatchObject({ exitCode: 101 });
        });

        it('reports the binary not being there', async () => {
            const server = new SimulatedCodexServer();
            server.deaf = true;
            const { output } = await run(server, {
                spawn: () => {
                    setImmediate(() => server.emit('error', new Error('spawn codex ENOENT')));
                    return server.process;
                },
            });

            expect(output.engineFailure).toMatch(/ENOENT/);
        });

        it('reports thread/start being refused', async () => {
            const server = new SimulatedCodexServer();
            server.failing.set('thread/start', 'bad model');
            const { output } = await run(server);

            expect(output.engineFailure).toMatch(/bad model/);
        });
    });

    describe('sessions and interruption', () => {
        it('records the thread as the session to resume', async () => {
            await run(new SimulatedCodexServer(report));

            expect(eventsOf('stage.engine-session')).toEqual([{ sessionId: 'thread-1' }]);
        });

        it('resumes a thread, telling the model it was interrupted', async () => {
            const server = new SimulatedCodexServer(report);
            server.threadId = 'earlier';
            await run(server, { resume: { sessionId: 'earlier' } });

            expect(startOf(server, 'thread/resume')).toMatchObject({ threadId: 'earlier', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
            expect(JSON.stringify(startOf(server, 'turn/start').input)).toMatch(/daemon restarted/);
        });

        it('starts a new thread when the old one cannot be resumed', async () => {
            const first = new SimulatedCodexServer();
            first.failing.set('thread/resume', 'no rollout found');
            const second = new SimulatedCodexServer(report);
            const servers = [first, second];
            const { output } = await run(first, { resume: { sessionId: 'gone' }, spawn: () => servers.shift()!.process });

            expect(output.result).toEqual({ summary: 'done' });
            expect(startOf(second, 'thread/start')).toMatchObject({ cwd: root });
            expect(JSON.stringify(startOf(second, 'turn/start').input)).toMatch(/earlier attempt/);
        });

        it('stops for an interrupt, saying where to pick up', async () => {
            const interrupts = new StageInterrupt();
            const { output } = await run(
                new SimulatedCodexServer(async () => {
                    interrupts.interrupt();
                }),
                { interrupts },
            );

            expect(output.truncated).toBe(true);
            expect(output.interrupted).toMatchObject({ sessionId: 'thread-1' });
            expect(output.engineFailure).toBeUndefined();
        });
    });

    it('tidies the runner channel and scratch away, however it ends', async () => {
        const host = { unlink: vi.spyOn(localHost, 'unlink'), removeTree: vi.spyOn(localHost, 'removeTree') };
        await run(new SimulatedCodexServer(report));

        expect(host.unlink).toHaveBeenCalledWith(join(root, '.wilson-report.json'));
        expect(host.removeTree).toHaveBeenCalledWith(join(root, '.wilson-scratch/'));
        vi.restoreAllMocks();
    });
});

describe('unwrapShell', () => {
    it.each([
        ["/bin/zsh -lc 'pnpm test'", 'pnpm test'],
        ["bash -c 'pnpm test'", 'pnpm test'],
        ['pnpm test', 'pnpm test'],
        ['/bin/zsh -lc "pnpm test"', '/bin/zsh -lc "pnpm test"'],
        ["bash -c 'a' 'b'", "bash -c 'a' 'b'"],
        ["python -c 'pnpm test'", "python -c 'pnpm test'"],
    ])('%s', (command, expected) => {
        expect(unwrapShell(command)).toBe(expected);
    });
});
