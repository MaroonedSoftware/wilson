import { createServer } from 'node:net';
import { Injectable } from 'injectkit';
import type { DevServerPortRange } from '#modules/settings/dev.server.port.range.setting.js';
import { LeaseService } from './lease.service.js';

export type PortAcquireResult = { readonly ok: true; readonly port: number } | { readonly ok: false; readonly reason: string };

/** The `runner.leases.resource_key` a port lives under — namespaced so a future resource type sharing this table cannot collide with a port number. */
const resourceKeyFor = (port: number): string => `port:${port}`;

/**
 * Whether `port` looks free on this machine right now, by trying to bind it.
 *
 * This is a probe, not a reservation: the socket is closed the instant it opens, and nothing stops
 * another process from taking the port in the gap between this check and the caller actually
 * starting its dev server there. See {@link DevServerPortAllocator.acquire}'s doc comment for why
 * that gap is accepted rather than closed.
 */
const isPortFree = (port: number): Promise<boolean> =>
    new Promise(resolve => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, () => {
            server.close(() => resolve(true));
        });
    });

/**
 * Card 0027. The first resource type built on {@link LeaseService} (card 0165 deliberately shipped
 * that mechanism unused — see its own doc comment). `LeaseService.acquire` only answers "may I have
 * this one" for a single `resourceKey`; it never picks, on purpose (card 0165's Constraints: "Do not
 * add a picking API to `LeaseService`"). This is the picking logic, one level up: walk a configured
 * range and take the first candidate `LeaseService` grants.
 */
@Injectable()
export class DevServerPortAllocator {
    constructor(private readonly leases: LeaseService) {}

    /**
     * Take the first port in `range` nobody else holds a lease on *and* that this machine does not
     * already have something bound to.
     *
     * A lease is coordination between cards on this board (`runner.leases`); it knows nothing about
     * a Postgres container, an editor's dev server, or another developer's process already listening
     * on that port. So a won lease is checked against the machine with {@link isPortFree} before it is
     * handed back — and when the probe finds the port taken, the lease already won for it is left
     * held (there is no per-resource release on `LeaseService`, only `releaseAll` for a whole card,
     * which fires when this card's worktree is reclaimed) and the loop moves on to the next
     * candidate. That still leaves a time-of-check/time-of-use gap between this probe and whatever the
     * caller actually binds to the port later — closing that gap would need an atomic
     * "reserve-and-hold" the OS does not offer for TCP ports, so it is accepted here, not solved.
     */
    async acquire(range: DevServerPortRange, project: string, cardId: string): Promise<PortAcquireResult> {
        for (let port = range.start; port <= range.end; port++) {
            const result = await this.leases.acquire(resourceKeyFor(port), project, cardId);
            if (!result.acquired) continue;
            if (await isPortFree(port)) return { ok: true, port };
        }
        return { ok: false, reason: `every port in ${range.start}-${range.end} is held or already bound on this machine` };
    }
}
