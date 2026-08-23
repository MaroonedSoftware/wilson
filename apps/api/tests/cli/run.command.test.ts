import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRunner as RealJobRunner } from '@maroonedsoftware/jobbroker';
import { BoardConfig, JobRunner } from '@wilson/api/cli-bootstrap';

// `run.command.ts` wraps its handler in johnny5's `requireContainer`, which bootstraps a real
// container from a real `AppConfig`. That machinery is out of scope here — this test is about the
// daemon's own start/stop/signal handling, not johnny5's DI plumbing — so `requireContainer` is
// replaced with the identity function, leaving the wrapped handler directly callable with a fake
// `ctx`.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

// Imported after the mock above is declared; vi.mock calls are hoisted above imports by vitest, so
// by the time this module (and transitively run.command.ts) loads, `requireContainer` is already
// the stub.
const { default: command } = await import('../../../../packages/cli/src/commands/run.command.js');

/** Flush every pending microtask (and the current macrotask queue) before proceeding. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;

const buildCtx = (runner: { start: () => Promise<void>; stop: () => Promise<void> }, project = 'wilson') => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const board = { project } as BoardConfig;
    const container = {
        get: (token: unknown) => {
            if (token === JobRunner) return runner;
            if (token === BoardConfig) return board;
            throw new Error(`buildCtx: unexpected token ${String(token)}`);
        },
    };
    return { ctx: { container, logger }, logger };
};

describe('cli-bootstrap JobRunner export', () => {
    it('re-exports the same JobRunner class the run command resolves through the container', () => {
        // `run.command.ts` looks the daemon up as `ctx.container.get(JobRunner)` using the token
        // imported from `@wilson/api/cli-bootstrap`; for that to find anything registered by
        // `@maroonedsoftware/jobbroker`'s DI setup, this re-export has to be the very same class,
        // not a copy or a structurally-similar stand-in.
        expect(JobRunner).toBe(RealJobRunner);
    });
});

describe('run command', () => {
    afterEach(() => {
        // The command never removes its own signal listeners (there is no `process.off` in the
        // handler), so a leftover listener from one test would otherwise fire again in the next one.
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        vi.restoreAllMocks();
    });

    it('starts the runner, blocks, and stops it once a shutdown signal arrives', async () => {
        const runner = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
        const { ctx, logger } = buildCtx(runner, 'my-project');

        const run = command.run as unknown as Handler;
        const runPromise = run({}, ctx, []);

        // Give the handler's first `await runner.start()` a chance to resolve so the SIGINT/SIGTERM
        // listeners are actually registered before the signal is sent.
        await flush();
        expect(runner.start).toHaveBeenCalledTimes(1);
        expect(runner.stop).not.toHaveBeenCalled();
        expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);

        process.emit('SIGINT');

        const result = await runPromise;

        expect(result).toBe(0);
        expect(runner.stop).toHaveBeenCalledTimes(1);
        // `start` must complete before `stop` is even attempted.
        expect(runner.start.mock.invocationCallOrder[0]).toBeLessThan(runner.stop.mock.invocationCallOrder[0]);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('my-project'));
    });

    it('reacts to SIGTERM the same way it reacts to SIGINT', async () => {
        const runner = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
        const { ctx } = buildCtx(runner);

        const run = command.run as unknown as Handler;
        const runPromise = run({}, ctx, []);
        await flush();

        process.emit('SIGTERM');

        const result = await runPromise;

        expect(result).toBe(0);
        expect(runner.stop).toHaveBeenCalledTimes(1);
    });

    it('force-exits instead of stopping again if a second signal arrives mid-shutdown', async () => {
        const runner = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
        const { ctx, logger } = buildCtx(runner);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        const run = command.run as unknown as Handler;
        const runPromise = run({}, ctx, []);
        await flush();

        // The first signal begins the shutdown sequence.
        process.emit('SIGINT');
        // The second, sent before shutdown has a chance to complete, must trigger a forced exit
        // rather than starting a second `runner.stop()`.
        process.emit('SIGINT');

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shutdown already in progress'));

        await runPromise;
    });
});
