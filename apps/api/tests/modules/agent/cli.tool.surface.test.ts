import { describe, expect, it } from 'vitest';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Card 0096. Every other suite in this directory mocks `@anthropic-ai/claude-agent-sdk` — deliberately
 * here, not: what this card is about is what the *real* installed SDK resolves the tool surface to,
 * and a mock can only ever answer that with whatever a human already assumed. `createToolGuard`
 * denying a leaked tool (`cli.tool.guard.test.ts`) proves the guard works; it does not prove the tool
 * was never on the list the model saw, which is the whole of what this card fixes.
 *
 * The `init` message is the CLI's own account of that list — "session metadata the CLI emits at the
 * start of each turn, normally ahead of every other message of that turn" per the SDK's own type
 * declaration — so it is read directly, and the stream is aborted the instant it arrives. That message
 * is produced by the CLI's local startup (resolving settings, connecting configured MCP servers,
 * computing the tool list) before any turn is dispatched to the API, so this costs no model turn and no
 * API tokens.
 *
 * What this suite does *not* do: compare the real operator's `HOME` against an empty one. Tried first,
 * and it doesn't isolate what this card is about — this machine's real `~/.claude` also carries a
 * `plugins` directory, and plugin-provided tools (`Monitor`, `PushNotification`, `ListAgents`, …) turn
 * out to be discovered by scanning that directory regardless of `settingSources`, which is a genuine,
 * accepted difference between machines that "Out of scope: Trimming the engine's own tools" already
 * covers — mixing it into this assertion would fail the test for a reason this card doesn't own. So
 * both runs below use a from-scratch `HOME`, differing *only* in `.claude/settings.json`, which isolates
 * exactly the axis this card is about.
 */

const wilsonToolSchemas = {
    report_result: z.object({ summary: z.string().optional() }),
    request_scope: z.object({ path: z.string(), reason: z.string() }),
    delete: z.object({ path: z.string() }),
};

/** The same three tools `CliStageAgent` registers on its `wilson` MCP server, for an `rw` stage. */
const wilsonServer = () =>
    createSdkMcpServer({
        name: 'wilson',
        tools: Object.entries(wilsonToolSchemas).map(([name, schema]) =>
            tool(name, name, schema.shape, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
        ),
        alwaysLoad: true,
    });

/**
 * A hand-rolled MCP server speaking just enough of the stdio JSON-RPC protocol to answer
 * `initialize` and `tools/list`, offering one tool: `ping`. No dependency on the MCP SDK package,
 * which isn't resolvable from this workspace's `node_modules` — this is the same protocol, just
 * written directly, and it is exactly the shape a real project `.mcp.json` or a real operator's
 * `~/.claude.json` (what `claude mcp add --scope user` writes to) would point at.
 */
const DECOY_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'decoy', version: '0.0.1' } } });
    } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (msg.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });
    } else if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
});
`;

/**
 * A from-scratch `HOME` whose `~/.claude.json` names the decoy MCP server above, and whose
 * `.claude/settings.json` carries a couple of unrelated settings too — so the fixture stands in for
 * "an operator's settings files" broadly, not just the one field this card is about — when
 * `withDecoyMcpServer` is true; otherwise a `HOME` with no `.claude` and no `.claude.json` at all.
 * Both are equally free of a `plugins` directory, an `agents` directory and stored credentials, so
 * comparing runs built from these two holds every other axis fixed and varies only the settings files.
 */
const buildHome = async (withDecoyMcpServer: boolean): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), 'cli-tool-surface-home-'));
    if (!withDecoyMcpServer) return home;

    const claudeDir = join(home, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const scriptPath = join(claudeDir, 'decoy-mcp-server.cjs');
    await writeFile(scriptPath, DECOY_SERVER_SCRIPT, 'utf8');
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ outputStyle: 'Explanatory', permissions: { allow: ['Bash(*)'] } }), 'utf8');
    // `Settings` (settings.json's own schema) carries no `mcpServers` key at all — a server an
    // operator adds via `claude mcp add --scope user` is recorded in `~/.claude.json` instead, which
    // is the file this repo's own leaked `codebase-memory-mcp` server actually lives in.
    await writeFile(
        join(home, '.claude.json'),
        JSON.stringify({ mcpServers: { decoy: { type: 'stdio', command: process.execPath, args: [scriptPath], alwaysLoad: true } } }),
        'utf8',
    );
    return home;
};

type InitMessage = { tools: string[]; mcp_servers: { name: string; status: string }[] };

/** Spawns the real engine, reads the `init` message, and aborts — see the class doc above for why
 * that costs no model turn. `options` layers on top of the shared base so each call site only states
 * what it varies. */
const initMessageFor = async (home: string, options: Record<string, unknown> = {}): Promise<InitMessage> => {
    const abortController = new AbortController();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const stream = query({
        prompt: 'Immediately stop. Do not call any tool.',
        options: {
            cwd: process.cwd(),
            permissionMode: 'default',
            env,
            mcpServers: { wilson: wilsonServer() },
            abortController,
            ...options,
        },
    });
    try {
        for await (const message of stream) {
            if (message.type === 'system' && message.subtype === 'init') {
                return { tools: message.tools, mcp_servers: message.mcp_servers };
            }
        }
        throw new Error('engine stream ended before an init message arrived');
    } finally {
        abortController.abort();
    }
};

describe('the cli adapter’s real tool surface, from a live engine’s init message', () => {
    it('is exactly this adapter’s three mcp tools plus the engine tools the guard names, with no other mcp__ tool, and does not vary with the operator’s settings files', async () => {
        const bareHome = await buildHome(false);
        const decoyHome = await buildHome(true);

        // The fix this card makes: pinned, the two homes — one with no settings file at all, one
        // whose settings.json names a real, working MCP server — resolve identically.
        const [withNoSettings, withADecoyServerConfigured] = await Promise.all([
            initMessageFor(bareHome, { settingSources: [], strictMcpConfig: true }),
            initMessageFor(decoyHome, { settingSources: [], strictMcpConfig: true }),
        ]);

        for (const init of [withNoSettings, withADecoyServerConfigured]) {
            // Read/Glob/Grep/Write/Edit/Bash are the names `createToolGuard` gates by, but this
            // installed CLI's `init` message only ever lists a `Read`/`Write`/`Edit`/`Bash`
            // quartet as top-level tool names — so only those four are asserted; the guard staying
            // ready for `Glob`/`Grep` if a future CLI reintroduces them by name is that guard's own
            // suite's concern, not this one's.
            expect(init.tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']));
            expect(init.tools).toEqual(expect.arrayContaining(['mcp__wilson__report_result', 'mcp__wilson__request_scope', 'mcp__wilson__delete']));

            // The absence this card exists to prove: no `mcp__` tool from any server but this
            // adapter's own — not "the guard would deny it if offered", which `mcp__elsewhere__…`
            // in `cli.tool.guard.test.ts` already covers and doesn't need repeating here.
            const mcpTools = init.tools.filter(name => name.startsWith('mcp__')).sort();
            expect(mcpTools).toEqual(['mcp__wilson__delete', 'mcp__wilson__report_result', 'mcp__wilson__request_scope']);
        }

        // Not merely "no leaked mcp__ tool" on each run individually — the whole resolved surface,
        // tool-for-tool, is the same whether the settings file exists or not. That's what makes the
        // stage reproducible rather than a function of whichever settings file happens to be there.
        expect(withNoSettings.tools.slice().sort()).toEqual(withADecoyServerConfigured.tools.slice().sort());

        // And the decoy server itself is real, not inert: pointed at by the same settings.json but
        // read *without* this card's fix, its tool does leak onto the list. Without this, a decoy
        // that silently failed to connect would make every assertion above pass vacuously.
        const unpinned = await initMessageFor(decoyHome, {});
        expect(unpinned.tools).toContain('mcp__decoy__ping');
    }, 60000);
});
