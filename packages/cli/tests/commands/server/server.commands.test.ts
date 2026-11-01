import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: drainCommand, DRAIN_WAIT_POLL_MS } = await import('#src/commands/server/drain.command.js');
const { default: resumeCommand } = await import('#src/commands/server/resume.command.js');
const { default: statusCommand } = await import('#src/commands/server/status.command.js');

type Handler<Opts> = (opts: Opts, ctx: unknown, args: unknown[]) => Promise<number | void>;

const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { get: (_key: string, fallback: string) => fallback };
    return { ctx: { config, env: {}, logger }, logger };
};

const status = (overrides: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ draining: true, running: [], held: 0, planDrafts: 0, safeToRestart: true, ...overrides }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

describe('wilson server', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('drain turns the setting on and reports where it stands', async () => {
        fetchMock.mockResolvedValue(status({ running: [{ project: 'demo', cardId: '0001' }], held: 2, safeToRestart: false }));
        const { ctx, logger } = buildCtx();

        expect(await (drainCommand.run as Handler<object>)({}, ctx, [])).toBe(0);

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(String(url)).toContain('/api/settings/drain');
        expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify({ draining: true }) });
        expect(logger.info).toHaveBeenCalledWith('draining · running 1 (demo/0001) · held 2 · plan drafts 0');
    });

    it('drain --wait returns once a restart is safe', async () => {
        vi.useFakeTimers();
        fetchMock
            .mockResolvedValueOnce(status({ running: [{ project: 'demo', cardId: '0001' }], safeToRestart: false }))
            .mockResolvedValueOnce(status({ running: [{ project: 'demo', cardId: '0001' }], safeToRestart: false }))
            .mockResolvedValueOnce(status());
        const { ctx, logger } = buildCtx();

        const done = (drainCommand.run as Handler<{ wait: boolean }>)({ wait: true }, ctx, []);
        await vi.advanceTimersByTimeAsync(DRAIN_WAIT_POLL_MS * 2);

        expect(await done).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(logger.info).toHaveBeenLastCalledWith('draining, safe to restart · running 0 · held 0 · plan drafts 0');
        expect(logger.info).toHaveBeenCalledTimes(2);
    });

    it('resume turns the setting off', async () => {
        fetchMock.mockResolvedValue(status({ draining: false, safeToRestart: false }));
        const { ctx, logger } = buildCtx();

        expect(await (resumeCommand.run as Handler<object>)({}, ctx, [])).toBe(0);

        expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ draining: false }) });
        expect(logger.info).toHaveBeenCalledWith('not draining · running 0 · held 0 · plan drafts 0');
    });

    it('status only reads', async () => {
        fetchMock.mockResolvedValue(status());
        const { ctx } = buildCtx();

        expect(await (statusCommand.run as Handler<object>)({}, ctx, [])).toBe(0);

        expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
    });
});
