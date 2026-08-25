import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbandonedCardJobsError, BoardConfig, JobRunner } from '@wilson/api/cli-bootstrap';

// Same rationale as run.command.test.ts: `requireContainer` bootstraps a real container from a real
// `AppConfig`, which is out of scope for testing the daemon's own stop/signal handling, so it is
// replaced with the identity function.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

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

/**
 * Card 0066. `runner.stop()` used to always resolve, so `run.command.ts` had exactly one path after
 * `stopping…`: log `stopped` and exit 0, whether or not a job was actually still active. Now
 * `runner.stop()` can reject with `AbandonedCardJobsError` when shutdown gave up waiting on a wedged
 * handler, and this command's job is to turn that into something an operator watching the daemon
 * cannot mistake for a clean stop: a distinct log line naming what was abandoned, and a non-zero exit.
 */
describe('run command — abandoned shutdown reporting', () => {
    afterEach(() => {
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        vi.restoreAllMocks();
    });

    it('logs the abandoned cards distinctly from a clean stop and exits non-zero', async () => {
        const error = new AbandonedCardJobsError([{ cardId: '0052', jobId: 'job-9' }]);
        const runner = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockRejectedValue(error) };
        const { ctx, logger } = buildCtx(runner);

        const run = command.run as unknown as Handler;
        const runPromise = run({}, ctx, []);
        await flush();

        process.emit('SIGINT');

        const result = await runPromise;

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('0052'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('redelivered'));
        // A clean stop logs bare "stopped" via `logger.info`; an abandoned one must not, so an
        // operator scanning info-level logs for the word cannot mistake this for the same outcome.
        expect(logger.info).not.toHaveBeenCalledWith('stopped');
    });

    it('propagates a stop() failure that is not an AbandonedCardJobsError instead of reporting it as one', async () => {
        const boom = new Error('pool already closed');
        const runner = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockRejectedValue(boom) };
        const { ctx, logger } = buildCtx(runner);

        const run = command.run as unknown as Handler;
        const runPromise = run({}, ctx, []);
        await flush();

        process.emit('SIGINT');

        await expect(runPromise).rejects.toThrow('pool already closed');
        expect(logger.error).not.toHaveBeenCalled();
    });
});
