import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpTestServer {
    url: string;
    /** What it lists: change this to play a server that changes a tool. */
    tools: Tool[];
    /** What each tool answers, by name. An `echo` of the arguments when a name is missing. */
    answers: Map<string, CallToolResult>;
    /** Each `tools/call` it received. */
    calls: { name: string; args: unknown; authorization?: string }[];
    /** When set, refuses every request that does not carry this bearer token. */
    requireBearer?: string;
    /** When set, answers every request with a redirect to this address. */
    redirectTo?: string;
    /** How many requests reached it, whatever came of them. */
    hits: number;
    stop: () => Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

/** A real MCP server over Streamable HTTP on a local port, so a test exercises the real client and transport. */
export const startMcpTestServer = async (tools: Tool[] = []): Promise<McpTestServer> => {
    const state: McpTestServer = { url: '', tools, answers: new Map(), calls: [], hits: 0, stop: async () => {} };

    const http: HttpServer = createServer((req, res) => {
        void (async () => {
            state.hits += 1;
            if (state.redirectTo) {
                res.writeHead(307, { location: state.redirectTo }).end();
                return;
            }
            if (state.requireBearer && req.headers.authorization !== `Bearer ${state.requireBearer}`) {
                res.writeHead(401).end();
                return;
            }
            const authorization = req.headers.authorization;
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
            server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: state.tools }));
            server.setRequestHandler(CallToolRequestSchema, ({ params: { name, arguments: args } }) => {
                state.calls.push({ name, args, authorization });
                return state.answers.get(name) ?? { content: [{ type: 'text', text: JSON.stringify(args ?? {}) }] };
            });
            // Stateless: a server and transport per request.
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            res.on('close', () => void server.close());
            await server.connect(transport);
            await transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
        })().catch(() => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));

    state.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    state.stop = async () => {
        http.closeAllConnections();
        await new Promise(resolve => http.close(resolve));
    };
    return state;
};

export const testTool = (name: string, description = `Does ${name}`, readOnlyHint?: boolean): Tool => ({
    name,
    description,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    ...(readOnlyHint !== undefined && { annotations: { readOnlyHint } }),
});
