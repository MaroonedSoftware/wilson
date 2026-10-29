import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same seam `project/create.command.test.ts` stubs, for the reason it gives: `global.fetch` is what
// the real `WilsonSdk` built by `withApi` ends up calling.
const { default: setCommand } = await import('#src/commands/host/set.command.js');
const { default: listCommand } = await import('#src/commands/host/list.command.js');
const { default: addCommand } = await import('#src/commands/host/add.command.js');

type Handler<Opts> = (opts: Opts, ctx: unknown, args: unknown[]) => Promise<number | void>;

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

const host = {
    name: 'agent-3',
    kind: 'ssh',
    sshTarget: 'agent-3',
    slots: 2,
    enabled: true,
    draining: true,
    commandEnv: ['GITHUB_TOKEN'],
    projects: [{ project: 'tga', codeRoot: '/opt/agent/TGA', worktreeRoot: '/opt/agent/wt', runRoot: '/opt/agent/run' }],
    running: [{ slot: 1, project: 'tga', cardId: '0042', since: '2026-10-29T11:40:00Z' }],
};

const sentBody = (): unknown => JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));

describe('wilson host set', () => {
    it('sends only the fields its options name', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(host));
        const { ctx } = buildCtx();

        const result = await (setCommand.run as unknown as Handler<object>)({ drain: true, slots: 2 }, ctx, ['agent-3']);

        expect(result).toBe(0);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/api/hosts/agent-3');
        expect(init.method).toBe('PATCH');
        expect(sentBody()).toEqual({ slots: 2, draining: true });
    });

    it('maps --disable and --undrain to false', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...host, enabled: false, draining: false }));
        const { ctx } = buildCtx();

        await (setCommand.run as unknown as Handler<object>)({ disable: true, undrain: true }, ctx, ['agent-3']);

        expect(sentBody()).toEqual({ enabled: false, draining: false });
    });

    it('refuses contradictory or empty options without calling the API', async () => {
        const { ctx, logger } = buildCtx();

        expect(await (setCommand.run as unknown as Handler<object>)({ enable: true, disable: true }, ctx, ['agent-3'])).toBe(1);
        expect(await (setCommand.run as unknown as Handler<object>)({}, ctx, ['agent-3'])).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledTimes(2);
    });
});

describe('wilson host add', () => {
    it('sends --command-env as a list of names', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(host));
        const { ctx } = buildCtx();

        await (addCommand.run as unknown as Handler<object>)({ commandEnv: 'GITHUB_TOKEN, NPM_TOKEN,' }, ctx, ['agent-3']);

        expect(sentBody()).toEqual({ name: 'agent-3', commandEnv: ['GITHUB_TOKEN', 'NPM_TOKEN'] });
    });

    it('registers a worker host with --worker, and says it is one', async () => {
        const worker = { ...host, name: 'unraid-vm', kind: 'worker', sshTarget: undefined, slots: 1, projects: [], running: [] };
        fetchMock.mockResolvedValueOnce(jsonResponse(worker));
        const { ctx, logger } = buildCtx();

        await (addCommand.run as unknown as Handler<object>)({ worker: true }, ctx, ['unraid-vm']);

        expect(sentBody()).toEqual({ name: 'unraid-vm', kind: 'worker' });
        expect(logger.info).toHaveBeenCalledWith('unraid-vm registered (worker, 1 slot)');
    });

    it('leaves the SSH target and slots to the server when they are not given', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...host, slots: 1, projects: [] }));
        const { ctx } = buildCtx();

        await (addCommand.run as unknown as Handler<object>)({}, ctx, ['agent-3']);

        expect(sentBody()).toEqual({ name: 'agent-3' });
    });
});

describe('wilson host list', () => {
    it('prints each host’s state and probe, and one line per project it serves', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                host,
                {
                    name: 'box',
                    kind: 'ssh',
                    sshTarget: 'dev@box',
                    slots: 1,
                    enabled: false,
                    draining: false,
                    commandEnv: [],
                    projects: [],
                    running: [],
                    probe: { probedAt: '2026-10-29T12:00:00Z', ok: false, detail: 'ssh timed out' },
                },
            ]),
        );
        const { ctx, logger } = buildCtx();

        await (listCommand.run as unknown as Handler<object>)({}, ctx, []);

        const lines = logger.info.mock.calls.map(call => String(call[0]));
        expect(lines[0]).toBe('agent-3  draining  1/2 slots in use  commands get GITHUB_TOKEN from it  never probed');
        expect(lines[1]).toBe('  slot 1: tga 0042 since 2026-10-29T11:40:00Z');
        expect(lines[2]).toBe('  tga  /opt/agent/TGA  worktrees /opt/agent/wt  run /opt/agent/run');
        expect(lines[3]).toBe('box (ssh dev@box)  disabled  0/1 slot in use  probe failed: ssh timed out at 2026-10-29T12:00:00Z');
        expect(lines[4]).toContain('serves no project yet');
    });

    it('marks a worker host as one, in place of an SSH target', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                { name: 'unraid-vm', kind: 'worker', slots: 1, enabled: true, draining: false, commandEnv: [], projects: [], running: [] },
            ]),
        );
        const { ctx, logger } = buildCtx();

        await (listCommand.run as unknown as Handler<object>)({}, ctx, []);

        expect(String(logger.info.mock.calls[0]?.[0])).toBe('unraid-vm (worker)  enabled  0/1 slot in use  never probed');
    });
});
