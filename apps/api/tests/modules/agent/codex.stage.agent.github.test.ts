import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CodexStageAgent } from '#modules/agent/codex.stage.agent.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { localHost } from '#modules/host/local.execution.host.js';
import { GITHUB_TOOL } from '#modules/agent/tools/github.tool.js';
import type { ToolContext } from '#modules/agent/tools/index.js';
import type { StageConfig } from '#modules/stages/stage.config.js';
import { SimulatedCodexServer } from '#tests/support/simulated.codex.server.js';

/**
 * Card 0013 on the codex adapter: the GitHub read tool is a dynamic tool offered only when
 * `webAccess` allows it, each call is put to the same guard the cli adapter uses, and the fetch runs
 * in this process. Against the simulated app-server, with `fetch` stubbed so nothing leaves the machine.
 */
const logger = { info: () => {}, warn: vi.fn(), error: () => {}, debug: () => {} };
const resultSchema = z.object({ summary: z.string() });

describe('CodexStageAgent and webAccess', () => {
    let root: string;
    let events: { type: string; payload?: Record<string, unknown> }[];
    const eventsOf = (type: string) => events.filter(event => event.type === type).map(event => event.payload ?? {});

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'codex-github-'));
        events = [];
    });
    afterEach(async () => {
        vi.unstubAllGlobals();
        await rm(root, { recursive: true, force: true });
    });

    const run = async (server: SimulatedCodexServer, over: Partial<StageConfig> = {}) => {
        const context = {
            project: 'p',
            cardId: '0013',
            stage: 'implementing',
            worktreeRoot: root,
            scope: new ScopeGuard({ worktreeRoot: root, allow: ['src/**'], alwaysAllowed: [] }),
            commands: new CommandAllowlist(['pnpm test']),
            scopeViolationPolicy: 'widen',
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
                spawnCodex: () => server.process,
            },
        } as unknown as ToolContext;
        const stage = {
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
        } as unknown as StageConfig;
        const input = { stage, context, planPath: '/plans/plan.md', title: 'A card', resultSchema, baseSha: 'abc' };
        return new CodexStageAgent(logger as never).run(input);
    };

    const startOf = (server: SimulatedCodexServer, method: string) => server.received.find(request => request.method === method)?.params ?? {};
    const toolNames = (server: SimulatedCodexServer) => (startOf(server, 'thread/start').dynamicTools as { name: string }[]).map(tool => tool.name);
    const promptOf = (server: SimulatedCodexServer) => JSON.stringify(startOf(server, 'turn/start').input);
    const report = (server: SimulatedCodexServer) => server.callTool('report_result', { summary: 'done' });
    const url = 'https://raw.githubusercontent.com/o/r/main/README.md';

    it.each([{}, { webAccess: 'none' as const }])('AC1, AC10: offers no GitHub tool at %j, and refuses a call to it', async over => {
        let reply: { text?: string; success?: boolean } | undefined;
        const server = new SimulatedCodexServer(async s => {
            reply = await s.callTool(GITHUB_TOOL, { url });
            await report(s);
        });

        await run(server, over);

        expect(toolNames(server)).not.toContain(GITHUB_TOOL);
        expect(promptOf(server)).not.toMatch(/GitHub/);
        expect(reply).toEqual({ text: `error: ${GITHUB_TOOL} is not available to this stage`, success: false });
        expect(eventsOf('tool.denied')).toEqual([expect.objectContaining({ tool: GITHUB_TOOL, url })]);
    });

    it('AC2, AC8, AC10: at github, offers the tool, fetches here and records the call', async () => {
        const fetchMock = vi.fn(async () => new Response('# readme', { status: 200, headers: { 'content-type': 'text/plain' } }));
        vi.stubGlobal('fetch', fetchMock);
        let reply: { text?: string; success?: boolean } | undefined;
        const server = new SimulatedCodexServer(async s => {
            reply = await s.callTool(GITHUB_TOOL, { url });
            await report(s);
        });

        await run(server, { webAccess: 'github' });

        expect(toolNames(server)).toContain(GITHUB_TOOL);
        expect(promptOf(server)).toContain('untrusted material to reason about');
        expect(reply).toEqual({ text: `${url}\nHTTP 200\n\n# readme`, success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(eventsOf('tool.executed')).toEqual([{ tool: GITHUB_TOOL, url, status: 200 }]);
    });

    it('AC3, AC10: at github, refuses another host without fetching', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        let reply: { text?: string; success?: boolean } | undefined;
        const server = new SimulatedCodexServer(async s => {
            reply = await s.callTool(GITHUB_TOOL, { url: 'https://example.com/x' });
            await report(s);
        });

        await run(server, { webAccess: 'github' });

        expect(reply?.success).toBe(false);
        expect(reply?.text).toMatch(/example\.com is not a GitHub host/);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(eventsOf('tool.denied')).toEqual([expect.objectContaining({ url: 'https://example.com/x' })]);
    });

    it('AC3, AC10: at github, refuses an http URL on a GitHub host without fetching', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        let reply: { text?: string; success?: boolean } | undefined;
        const server = new SimulatedCodexServer(async s => {
            reply = await s.callTool(GITHUB_TOOL, { url: 'http://raw.githubusercontent.com/o/r/main/x' });
            await report(s);
        });

        await run(server, { webAccess: 'github' });

        expect(reply?.success).toBe(false);
        expect(reply?.text).toMatch(/only https/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('AC3, AC8, AC10: at github, refuses a redirect off GitHub without following it', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
        vi.stubGlobal('fetch', fetchMock);
        let reply: { text?: string; success?: boolean } | undefined;
        const server = new SimulatedCodexServer(async s => {
            reply = await s.callTool(GITHUB_TOOL, { url: 'https://github.com/o/r/raw/main/x' });
            await report(s);
        });

        await run(server, { webAccess: 'github' });

        expect(reply?.text).toMatch(/redirects to https:\/\/evil\.example\/steal, which was not followed/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(eventsOf('tool.denied')).toEqual([expect.objectContaining({ tool: GITHUB_TOOL, url: 'https://github.com/o/r/raw/main/x', status: 302 })]);
    });

    it('AC4, AC10: at github, offers no web tool of its own and refuses one called by name', async () => {
        let reply: { text?: string; success?: boolean } | undefined;
        const server = new SimulatedCodexServer(async s => {
            reply = await s.callTool('web_search', { query: 'x' });
            await report(s);
        });

        await run(server, { webAccess: 'github' });

        expect(toolNames(server).filter(name => /web/i.test(name))).toEqual([]);
        expect(reply?.success).toBe(false);
    });
});
