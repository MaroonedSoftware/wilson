import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The same seam as `host.commands.test.ts`: `global.fetch` is what the real `WilsonSdk` ends up calling.
const { default: setCommand } = await import('#src/commands/secret/set.command.js');
const { default: listCommand } = await import('#src/commands/secret/list.command.js');
const { default: removeCommand } = await import('#src/commands/secret/remove.command.js');
const { terminalIo } = await import('#src/sign.in.js');

type Handler = (opts: object, ctx: unknown, args: unknown[]) => Promise<number | void>;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { get: (_key: string, fallback: string) => fallback };
    return { ctx: { config, env: {}, logger }, logger };
};

const saved = { name: 'linear', createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' };

describe('wilson secret', () => {
    it('saves a value read from stdin, in the body and never the URL', async () => {
        vi.spyOn(terminalIo, 'readStdin').mockResolvedValue('the-value');
        fetchMock.mockResolvedValue(jsonResponse(saved));
        const { ctx, logger } = buildCtx();

        await expect((setCommand.run as Handler)({}, ctx, ['linear'])).resolves.toBe(0);

        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toContain('/api/secrets/linear');
        expect(url).not.toContain('the-value');
        expect(JSON.parse(init.body as string)).toEqual({ value: 'the-value' });
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain('the-value');
    });

    it('lists names and never asks for a value', async () => {
        fetchMock.mockResolvedValue(jsonResponse([saved]));
        const { ctx, logger } = buildCtx();

        await (listCommand.run as Handler)({}, ctx, []);

        expect(logger.info.mock.calls[0]![0]).toContain('linear');
    });

    it('says how to save one when there are none', async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        await (listCommand.run as Handler)({}, ctx, []);

        expect(logger.info.mock.calls[0]![0]).toContain('wilson secret set');
    });

    it('removes by name', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        const { ctx } = buildCtx();

        await expect((removeCommand.run as Handler)({}, ctx, ['linear'])).resolves.toBe(0);

        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toContain('/api/secrets/linear');
        expect(init.method).toBe('DELETE');
    });
});
