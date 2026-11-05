import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The same seam as `host.commands.test.ts`: `global.fetch` is what the real `WilsonSdk` ends up calling.
const { default: addCommand } = await import('#src/commands/mcp/add.command.js');
const { default: listCommand } = await import('#src/commands/mcp/list.command.js');
const { default: reviewCommand } = await import('#src/commands/mcp/review.command.js');
const { default: toolsCommand } = await import('#src/commands/mcp/tools.command.js');

type Handler = (opts: object, ctx: unknown, args: unknown[]) => Promise<number | void>;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { get: (_key: string, fallback: string) => fallback };
    return { ctx: { config, env: {}, logger }, logger };
};

const connection = {
    name: 'linear',
    url: 'https://mcp.example.test/mcp',
    secret: 'linear-key',
    tools: [
        { name: 'list_issues', description: 'Lists issues', inputSchema: { type: 'object' }, readOnlyHint: true, access: 'read', needsReview: false },
        {
            name: 'close_issue',
            description: 'Closes an issue',
            inputSchema: { type: 'object' },
            readOnlyHint: false,
            access: 'change',
            needsReview: true,
        },
    ],
    refreshedAt: '2026-11-05T00:00:00Z',
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
};

const logged = (logger: ReturnType<typeof buildCtx>['logger']): string => logger.info.mock.calls.map(call => String(call[0])).join('\n');

describe('wilson mcp', () => {
    it('adds a connection, shows what it lists, and says nothing is usable yet', async () => {
        fetchMock.mockResolvedValue(jsonResponse(connection));
        const { ctx, logger } = buildCtx();

        await expect((addCommand.run as Handler)({ secret: 'linear-key' }, ctx, ['linear', connection.url])).resolves.toBe(0);

        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toContain('/api/mcp-connections/linear');
        expect(JSON.parse(init.body as string)).toEqual({ url: connection.url, secret: 'linear-key' });
        expect(logged(logger)).toContain('Closes an issue');
        expect(logged(logger)).toContain('wilson mcp review linear');
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns before sending a secret over plain http', async () => {
        fetchMock.mockResolvedValue(jsonResponse(connection));
        const { ctx, logger } = buildCtx();

        await (addCommand.run as Handler)({ secret: 'linear-key' }, ctx, ['linear', 'http://10.0.0.5/mcp']);

        expect(logger.warn.mock.calls[0]![0]).toContain('plain http');
    });

    it('sends each tool with the access it was given', async () => {
        fetchMock.mockResolvedValue(jsonResponse(connection));
        const { ctx } = buildCtx();

        await (reviewCommand.run as Handler)({ read: 'a, b', change: 'c', disable: 'd' }, ctx, ['linear']);

        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toContain('/api/mcp-connections/linear/tools');
        expect(JSON.parse(init.body as string)).toEqual({
            tools: [
                { name: 'a', access: 'read' },
                { name: 'b', access: 'read' },
                { name: 'c', access: 'change' },
                { name: 'd', access: 'disabled' },
            ],
        });
    });

    it('refuses a review that names no tool, or gives one tool two answers', async () => {
        const { ctx, logger } = buildCtx();

        await expect((reviewCommand.run as Handler)({}, ctx, ['linear'])).resolves.toBe(1);
        await expect((reviewCommand.run as Handler)({ read: 'a', change: 'a' }, ctx, ['linear'])).resolves.toBe(1);

        expect(logger.error).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('lists how many tools are usable and how many wait', async () => {
        fetchMock.mockResolvedValue(jsonResponse([connection]));
        const { ctx, logger } = buildCtx();

        await (listCommand.run as Handler)({}, ctx, []);

        expect(logged(logger)).toContain('1 of 2 tools usable');
        expect(logged(logger)).toContain('1 need review');
    });

    it("shows a connection's tools, and fails on an unknown one", async () => {
        fetchMock.mockImplementation(async () => jsonResponse([connection]));
        const { ctx, logger } = buildCtx();

        await expect((toolsCommand.run as Handler)({}, ctx, ['linear'])).resolves.toBe(0);
        expect(logged(logger)).toContain('NEEDS REVIEW');

        await expect((toolsCommand.run as Handler)({}, ctx, ['nothing'])).resolves.toBe(1);
    });
});
