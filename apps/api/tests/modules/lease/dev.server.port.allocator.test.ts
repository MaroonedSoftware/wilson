import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevServerPortAllocator } from '#modules/lease/dev.server.port.allocator.js';
import type { LeaseService, AcquireResult } from '#modules/lease/lease.service.js';

/** Binds `port` and holds it until `close()` is called — simulates something already listening there. */
const occupy = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(port, () => resolve(server));
    });

const close = (server: Server): Promise<void> => new Promise(resolve => server.close(() => resolve()));

/**
 * Card 0027. `DevServerPortAllocator` is the picking logic built on top of `LeaseService.acquire`
 * (card 0165's own doc comment says it deliberately never picks). These exercise the allocator in
 * isolation, with a stubbed `LeaseService` — `lease.service.test.ts` already covers the real
 * acquire/steal/release mechanics against Postgres, so this only has to prove the allocator's own
 * contract: walk the range, skip a lease loss, skip a port that is bound on this machine even after
 * winning its lease, and fail naming the range when nothing is left.
 */
describe('DevServerPortAllocator.acquire', () => {
    const occupied: Server[] = [];
    afterEach(async () => {
        await Promise.all(occupied.splice(0).map(close));
    });

    const fakeLeases = (acquire: LeaseService['acquire'], release?: LeaseService['release']): LeaseService =>
        ({ acquire, release: release ?? vi.fn(async () => undefined) }) as unknown as LeaseService;

    it('takes the first port in the range once the lease for it is granted and the port is free on this machine', async () => {
        const acquire = vi.fn(async (): Promise<AcquireResult> => ({ acquired: true }));
        const allocator = new DevServerPortAllocator(fakeLeases(acquire));

        const result = await allocator.acquire({ start: 41000, end: 41002 }, 'proj', '0001');

        expect(result).toEqual({ ok: true, port: 41000 });
        expect(acquire).toHaveBeenCalledWith('port:41000', 'proj', '0001');
    });

    it('skips a port whose lease is already held by another card, and takes the next one granted', async () => {
        const acquire = vi.fn(async (resourceKey: string): Promise<AcquireResult> =>
            resourceKey === 'port:41010' ? { acquired: false, heldBy: { resourceKey, project: 'other', cardId: '0099' } } : { acquired: true },
        );
        const allocator = new DevServerPortAllocator(fakeLeases(acquire));

        const result = await allocator.acquire({ start: 41010, end: 41012 }, 'proj', '0001');

        expect(result).toEqual({ ok: true, port: 41011 });
        expect(acquire).toHaveBeenCalledWith('port:41010', 'proj', '0001');
        expect(acquire).toHaveBeenCalledWith('port:41011', 'proj', '0001');
    });

    /**
     * The crux of this card's own constraint: "a lease is not proof the port is free on the
     * machine". This binds a real socket on the range's first port before the allocator ever runs,
     * so a lease that is granted for it must still be rejected by the machine-level probe, and the
     * loop must move on to the next candidate rather than handing back a port something is already
     * listening on.
     */
    it('skips a port that wins its lease but is already bound on this machine, releasing that lease before moving to the next candidate', async () => {
        const port = 41020;
        occupied.push(await occupy(port));

        const acquire = vi.fn(async (): Promise<AcquireResult> => ({ acquired: true }));
        const release = vi.fn(async () => undefined);
        const allocator = new DevServerPortAllocator(fakeLeases(acquire, release));

        const result = await allocator.acquire({ start: port, end: port + 1 }, 'proj', '0001');

        expect(result).toEqual({ ok: true, port: port + 1 });
        // Both candidates' leases were taken, but the occupied one is given back (card 0167's
        // `LeaseService.release`) rather than left held for the rest of this card's run.
        expect(acquire).toHaveBeenCalledWith(`port:${port}`, 'proj', '0001');
        expect(acquire).toHaveBeenCalledWith(`port:${port + 1}`, 'proj', '0001');
        expect(release).toHaveBeenCalledWith(`port:${port}`, 'proj', '0001');
        expect(release).not.toHaveBeenCalledWith(`port:${port + 1}`, 'proj', '0001');
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('gives up with a reason naming the range when every candidate is held', async () => {
        const acquire = vi.fn(async (resourceKey: string): Promise<AcquireResult> => ({
            acquired: false,
            heldBy: { resourceKey, project: 'other', cardId: '0099' },
        }));
        const allocator = new DevServerPortAllocator(fakeLeases(acquire));

        const result = await allocator.acquire({ start: 41030, end: 41031 }, 'proj', '0001');

        expect(result).toEqual({ ok: false, reason: expect.stringContaining('41030-41031') });
        expect(acquire).toHaveBeenCalledTimes(2);
    });

    it('gives up naming the range when every candidate is held or bound, not merely one or the other', async () => {
        const port = 41040;
        occupied.push(await occupy(port));
        // The first candidate wins its lease but is bound on the machine; the second loses its lease
        // outright. Either way, nothing is left to hand back.
        const acquire = vi.fn(async (resourceKey: string): Promise<AcquireResult> =>
            resourceKey === `port:${port}` ? { acquired: true } : { acquired: false, heldBy: { resourceKey, project: 'other', cardId: '0099' } },
        );
        const release = vi.fn(async () => undefined);
        const allocator = new DevServerPortAllocator(fakeLeases(acquire, release));

        const result = await allocator.acquire({ start: port, end: port + 1 }, 'proj', '0001');

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(`${port}-${port + 1}`);
        // The bound candidate's lease is given back even though the whole range ultimately fails.
        expect(release).toHaveBeenCalledWith(`port:${port}`, 'proj', '0001');
    });
});
