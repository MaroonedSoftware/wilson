import { describe, expect, it, vi } from 'vitest';
import { CardJobs, JobBroker, PgBoss } from '@wilson/api/cli-bootstrap';

// `release.command.ts` wraps its handler in johnny5's `requireContainer`, exactly like the other CLI
// commands under test here — see `move.command.test.ts` for why the stub below is enough to make the
// wrapped handler directly callable.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

// The command's only way of telling "a job the broker calls active might genuinely be running" from
// "the worker that claimed it is gone" is to check whether a `wilson run` daemon process exists at
// all. It does that with `execFile('pgrep', ...)` promisified. `child_process.execFile` carries a
// `util.promisify.custom` implementation that resolves to `{ stdout, stderr }` rather than the
// callback's raw `(err, stdout, stderr)` args, so the mock below has to supply that same custom
// promisified variant — a plain `vi.fn()` standing in for `execFile` would make `promisify(execFile)`
// resolve to `undefined` no matter what the mock returns, and every test would silently take the
// "no daemon" branch regardless of what it configured.
const { execFileImpl } = vi.hoisted(() => ({ execFileImpl: vi.fn() }));
vi.mock('node:child_process', async () => {
    const { promisify } = await import('node:util');
    const execFile = () => {
        throw new Error('execFile: test double only supports the promisify(execFile) path');
    };
    Object.defineProperty(execFile, promisify.custom, { value: (...args: unknown[]) => execFileImpl(...args) });
    return { execFile };
});

const { default: command } = await import('../../../../packages/cli/src/commands/card/release.command.js');

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;
const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

/** No `wilson run` process found — the real shape of a failed `pgrep -f` match. */
const noDaemonRunning = () => execFileImpl.mockRejectedValue(Object.assign(new Error('pgrep: no matching process'), { code: 1 }));
const daemonRunning = (pid = '4242') => execFileImpl.mockResolvedValue({ stdout: `${pid}\n`, stderr: '' });

const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pgBoss = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const cardJobs = { inFlight: vi.fn(), clear: vi.fn(async () => {}) };
    const broker = { getJob: vi.fn(), cancel: vi.fn(async () => {}) };
    const container = {
        get: (token: unknown) => {
            if (token === PgBoss) return pgBoss;
            if (token === CardJobs) return cardJobs;
            if (token === JobBroker) return broker;
            // Any other token — a `StageDispatcher`, a `JobRunner`, a `BoardRepository` — would mean
            // this command reached for something beyond "cancel through the broker, clear the
            // claim". This is a hard failure by construction, not something a test has to notice.
            throw new Error(`buildCtx: unexpected token ${String(token)}`);
        },
    };
    return { ctx: { container, logger }, logger, pgBoss, cardJobs, broker };
};

describe('wilson card release', () => {
    it('refuses outright when a wilson run daemon is active and the card holds a live claim, without ever cancelling or clearing', async () => {
        daemonRunning('9001');
        const { ctx, logger, pgBoss, cardJobs, broker } = buildCtx();
        cardJobs.inFlight.mockResolvedValue('job-42');

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('9001'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('in flight'));

        // The daemon guard only ever disambiguates a card that does hold a live claim — it runs
        // after `inFlight` confirms that, not before. Nothing broker-cancel-or-clear related is
        // reached once it refuses.
        expect(cardJobs.inFlight).toHaveBeenCalledWith('0001');
        expect(broker.getJob).not.toHaveBeenCalled();
        expect(broker.cancel).not.toHaveBeenCalled();
        expect(cardJobs.clear).not.toHaveBeenCalled();

        // The producer-only connection it opened to check the claim is still closed cleanly.
        expect(pgBoss.start).toHaveBeenCalledTimes(1);
        expect(pgBoss.stop).toHaveBeenCalledTimes(1);
    });

    it('reports "no claim" for a claimless card even while a wilson run daemon is active elsewhere', async () => {
        // This is the review fix this card exists to cover: a claimless card must never be reported
        // as "may genuinely be in flight" just because some daemon happens to be running somewhere.
        // The daemon probe must not even run — `inFlight` settles the question first.
        daemonRunning('9001');
        const { ctx, logger, pgBoss, cardJobs, broker } = buildCtx();
        cardJobs.inFlight.mockResolvedValue(undefined);
        // Calls accumulate on this shared mock across tests in the file (nothing resets it between
        // `it`s), so clear its call log now — what matters here is whether *this* run touches it.
        execFileImpl.mockClear();

        const result = await run(ctx, '0006');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('0006'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no claim'));
        expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('in flight'));
        expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('9001'));

        // The daemon probe (execFile via `runningDaemon`) is never even consulted for a claimless
        // card — proving the ordering, not just the outcome.
        expect(execFileImpl).not.toHaveBeenCalled();

        expect(broker.cancel).not.toHaveBeenCalled();
        expect(cardJobs.clear).not.toHaveBeenCalled();
        expect(pgBoss.start).toHaveBeenCalledTimes(1);
        expect(pgBoss.stop).toHaveBeenCalledTimes(1);
    });

    it('exits non-zero and writes nothing when the card holds no claim', async () => {
        noDaemonRunning();
        const { ctx, logger, pgBoss, cardJobs, broker } = buildCtx();
        cardJobs.inFlight.mockResolvedValue(undefined);

        const result = await run(ctx, '0002');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('0002'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no claim'));

        // Nothing was released because there was nothing to release: no cancel, no clear.
        expect(broker.cancel).not.toHaveBeenCalled();
        expect(cardJobs.clear).not.toHaveBeenCalled();

        // The producer-only connection it opened to ask is still closed cleanly.
        expect(pgBoss.start).toHaveBeenCalledTimes(1);
        expect(pgBoss.stop).toHaveBeenCalledTimes(1);
    });

    it('cancels a wedged active job through the broker and clears the claim, reporting success', async () => {
        noDaemonRunning();
        const { ctx, logger, pgBoss, cardJobs, broker } = buildCtx();
        cardJobs.inFlight.mockResolvedValue('job-77');
        broker.getJob.mockResolvedValue({ id: 'job-77', name: 'card.stage', state: 'active', data: {} });

        const result = await run(ctx, '0003');

        expect(result).toBe(0);

        // Cancelled, not deleted — a cancelled job leaves a record explaining the gap.
        expect(broker.cancel).toHaveBeenCalledWith('card.stage', 'job-77');
        expect(broker.cancel).toHaveBeenCalledTimes(1);

        // The claim is released.
        expect(cardJobs.clear).toHaveBeenCalledWith('0003');
        expect(cardJobs.clear).toHaveBeenCalledTimes(1);

        // It said what it was about to do and what it did, including the card's job state.
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('active'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cancelling'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('released'));

        // This releases the claim; it does not decide where the card goes next.
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('card move'));

        expect(pgBoss.start).toHaveBeenCalledTimes(1);
        expect(pgBoss.stop).toHaveBeenCalledTimes(1);

        // Cancel happens strictly before the claim is cleared, so a crash between the two still
        // leaves a claim pointing at a (by then cancelled) job rather than an orphaned live one.
        const cancelOrder = broker.cancel.mock.invocationCallOrder[0];
        const clearOrder = cardJobs.clear.mock.invocationCallOrder[0];
        expect(cancelOrder).toBeLessThan(clearOrder);
    });

    it('still closes the broker connection when cancelling the job fails partway through', async () => {
        noDaemonRunning();
        const { ctx, pgBoss, cardJobs, broker } = buildCtx();
        cardJobs.inFlight.mockResolvedValue('job-88');
        broker.getJob.mockResolvedValue({ id: 'job-88', name: 'card.stage', state: 'active', data: {} });
        broker.cancel.mockRejectedValue(new Error('boss: connection reset'));

        await expect(run(ctx, '0004')).rejects.toThrow('boss: connection reset');

        // The claim survives an aborted cancel rather than being cleared for a job that might still
        // be live — and the connection this command opened is still closed either way.
        expect(cardJobs.clear).not.toHaveBeenCalled();
        expect(pgBoss.start).toHaveBeenCalledTimes(1);
        expect(pgBoss.stop).toHaveBeenCalledTimes(1);
    });

    it('reports and cancels a job the broker cannot describe, rather than assuming settled', async () => {
        noDaemonRunning();
        const { ctx, logger, broker, cardJobs } = buildCtx();
        cardJobs.inFlight.mockResolvedValue('job-99');
        broker.getJob.mockResolvedValue(null);

        const result = await run(ctx, '0005');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('unknown'));
        expect(broker.cancel).toHaveBeenCalledWith('card.stage', 'job-99');
        expect(cardJobs.clear).toHaveBeenCalledWith('0005');
    });
});
