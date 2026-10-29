import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { DateTime } from 'luxon';
import type { IssuedWorkerToken } from '../../generated/hosts.js';
import { HostRepository, type HostRow } from './host.repository.js';
import { toHost } from './hosts.service.js';
import { hashWorkerToken, mintWorkerToken, WORKER_TOKEN_PREFIX } from './worker.token.js';

/**
 * The credential a worker host's worker program connects with (`POST`/`DELETE
 * /api/hosts/{name}/worker-token`), and the check the worker endpoint makes with it.
 *
 * A token names exactly one host and is good for nothing but connecting as it: the account API never
 * accepts one, and an account key is never accepted where a token is expected. Minting another
 * replaces the last, so rotating is minting again; revoking leaves the host with none.
 */
@Injectable()
export class WorkerTokensService {
    constructor(private readonly hosts: HostRepository) {}

    /**
     * Mint a token for worker host `name`, replacing any it had. Refuses an unknown host with 404 and
     * an `ssh` host, which has nothing to connect with one, with 400. The token is in this response
     * and nowhere else.
     */
    async issue(name: string): Promise<IssuedWorkerToken> {
        const row = await this.requireWorker(name);
        const minted = mintWorkerToken();
        await this.hosts.setWorkerToken(row.name, { hash: minted.hash, hint: minted.hint, issuedAt: DateTime.now() });
        return { token: minted.token, host: toHost((await this.hosts.find(row.name))!) };
    }

    /** Forget worker host `name`'s token. Refuses an unknown host with 404 and an `ssh` host with 400. */
    async revoke(name: string): Promise<void> {
        const row = await this.requireWorker(name);
        await this.hosts.clearWorkerToken(row.name);
    }

    /**
     * The worker host `token` connects as, or undefined when it names none that may connect: no such
     * token, or a host that is disabled. Never throws for a bad token, so a caller cannot tell "wrong
     * token" from "disabled host" by how it failed.
     */
    async authenticate(token: string): Promise<HostRow | undefined> {
        if (!token.startsWith(WORKER_TOKEN_PREFIX)) return undefined;
        const row = await this.hosts.findByWorkerTokenHash(hashWorkerToken(token));
        if (!row || row.kind !== 'worker' || !row.enabled) return undefined;
        return row;
    }

    private async requireWorker(name: string): Promise<HostRow> {
        const row = await this.hosts.find(name);
        if (!row) throw httpError(404).withDetails({ reason: `host "${name}" is not registered` });
        if (row.kind !== 'worker') {
            throw httpError(400).withDetails({ reason: `host "${name}" is reached over SSH; only a worker host has a worker token` });
        }
        return row;
    }
}
