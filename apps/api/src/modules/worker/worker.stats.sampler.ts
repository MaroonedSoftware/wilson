import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { DateTime } from 'luxon';
import { HostRepository } from '#modules/host/host.repository.js';
import type { WorkerConnection } from './worker.connection.js';
import { WorkerConnections } from './worker.connections.js';

/** How often each connected worker is asked. The Hosts page reads every ten seconds, and a machine's load needs no finer. */
const SAMPLE_INTERVAL_MS = 30_000;

/** A worker this slow to answer has no reading worth showing, and one sample must not outlast the next. */
const SAMPLE_TIMEOUT_MS = 10_000;

/**
 * Asks each connected worker how its machine is doing and leaves the answer on its connection, for
 * `toHost` to read. Wilson drives here as everywhere on this connection: a worker never reports
 * anything it was not asked for. Nothing is written to the database, so there is no history, only
 * the latest reading.
 */
@Injectable()
export class WorkerStatsSampler {
    constructor(
        private readonly connections: WorkerConnections,
        private readonly hosts: HostRepository,
        private readonly logger: Logger,
    ) {}

    /** Sample every connected worker on an interval, until `signal` aborts. */
    start(signal: AbortSignal, intervalMs = SAMPLE_INTERVAL_MS): void {
        const timer = setInterval(() => void this.sampleAll(), intervalMs);
        timer.unref();
        signal.addEventListener('abort', () => clearInterval(timer));
    }

    async sampleAll(): Promise<void> {
        await Promise.all(this.connections.all().map(connection => this.sample(connection)));
    }

    /** Take a reading from host `hostName`'s worker, if it is connected: one just connected need not wait for the interval. */
    async sampleHost(hostName: string): Promise<void> {
        const connection = this.connections.get(hostName);
        if (connection) await this.sample(connection);
    }

    /** Never throws. A failed reading clears the last one rather than leaving old numbers looking current. */
    private async sample(connection: WorkerConnection): Promise<void> {
        try {
            const host = await this.hosts.find(connection.hostName);
            const paths = (host?.projects ?? []).flatMap(project => [project.codeRoot, project.worktreeRoot, project.runRoot]);
            const stats = await connection.call({ op: 'stats', paths }, SAMPLE_TIMEOUT_MS);
            connection.latestStats = { ...stats, sampledAt: DateTime.now() };
        } catch (err) {
            connection.latestStats = undefined;
            this.logger.warn(`could not read the machine of host ${connection.hostName}: ${(err as Error).message}`);
        }
    }
}
