import { WorkerCloseCode } from '@wilson/worker-protocol';
import type { WorkerConnection } from './worker.connection.js';

/**
 * The worker connections open right now, one per host. A singleton (`WorkerModule`): the endpoint
 * adds to it and the probe and placement read it, all in this one process.
 *
 * A host is one machine, so a second connection for it means the first has gone stale (the worker
 * restarted before the old socket noticed) or two machines hold one token. Either way the newer one
 * wins and the older is closed with {@link WorkerCloseCode.Superseded}, which a worker does not retry.
 */
export class WorkerConnections {
    private readonly byHost = new Map<string, WorkerConnection>();

    /** Keep `connection` as its host's, closing any it replaces. */
    register(connection: WorkerConnection): void {
        const previous = this.byHost.get(connection.hostName);
        this.byHost.set(connection.hostName, connection);
        previous?.close(WorkerCloseCode.Superseded, 'another connection for this host replaced it');
        connection.onClose(() => {
            if (this.byHost.get(connection.hostName) === connection) this.byHost.delete(connection.hostName);
        });
    }

    /** Host `name`'s open connection, or undefined when its worker is not connected. */
    get(name: string): WorkerConnection | undefined {
        const connection = this.byHost.get(name);
        return connection?.open ? connection : undefined;
    }

    /** Close every connection: the server is shutting down. Workers reconnect once it is back. */
    closeAll(reason: string): void {
        for (const connection of this.byHost.values()) connection.close(1001, reason);
        this.byHost.clear();
    }
}
