import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** How long a server has to answer any one request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Stops a server that keeps answering with another page. */
const MAX_LIST_PAGES = 20;

/** A tool as a server lists it, with only what reaches a model or a review. */
export interface ListedTool {
    name: string;
    description: string;
    inputSchema: unknown;
    readOnlyHint: boolean;
    fingerprint: string;
}

/** `value` as JSON with every object's keys sorted, so a server reordering them changes nothing. */
const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, part: unknown) =>
        part !== null && typeof part === 'object' && !Array.isArray(part)
            ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : part,
    );

/** One connection to a server: open it, make the calls one operation needs, and close it. */
export class McpSession {
    private constructor(private readonly client: Client) {}

    /**
     * Connect to `url`. `bearer` goes only in the `Authorization` header. A redirect is refused rather
     * than followed, so a server cannot send the messages and that header somewhere else.
     */
    static async open(url: string, bearer?: string): Promise<McpSession> {
        const client = new Client({ name: 'wilson', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: {
                redirect: 'error',
                ...(bearer !== undefined && { headers: { Authorization: `Bearer ${bearer}` } }),
            },
        });
        await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
        return new McpSession(client);
    }

    /** Every tool the server lists. Fingerprints what can reach a model, and the hints, whose change a person should see. */
    async list(): Promise<ListedTool[]> {
        const tools: ListedTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const listed = await this.client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: REQUEST_TIMEOUT_MS });
            for (const { name, title, description = '', inputSchema, annotations } of listed.tools) {
                const fingerprint = createHash('sha256').update(canonical({ name, title, description, inputSchema, annotations })).digest('hex');
                tools.push({ name, description, inputSchema, readOnlyHint: annotations?.readOnlyHint === true, fingerprint });
            }
            cursor = listed.nextCursor;
            if (cursor === undefined) return tools;
        }
        throw new Error(`the server was still listing tools after ${MAX_LIST_PAGES} pages`);
    }

    async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
        return (await this.client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS })) as CallToolResult;
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
