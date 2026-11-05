import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { WorkerClient } from '../src/worker.client.js';

/**
 * The client's own watch on its connection, against a plain WebSocket server that stands in for a
 * Wilson that has gone quiet: nothing is closed from that end, which is what a network cut looks like.
 */
describe('WorkerClient', () => {
    const SILENCE_LIMIT_MS = 100;
    let server: Server;
    let client: WorkerClient | undefined;
    let timers: NodeJS.Timeout[] = [];

    /** A server that calls `onConnection` for each connection, and counts them. */
    const listen = async (onConnection: (socket: WebSocket) => void = () => {}) => {
        server = createServer();
        const wss = new WebSocketServer({ server });
        const connections: WebSocket[] = [];
        wss.on('connection', socket => {
            connections.push(socket);
            onConnection(socket);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        return { connections, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    };

    const start = (url: string): void => {
        client = new WorkerClient({ url, token: 'token', version: '0.0.1-test', minReconnectMs: 10, silenceLimitMs: SILENCE_LIMIT_MS });
        void client.run().catch(() => {});
    };

    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    afterEach(async () => {
        for (const timer of timers) clearInterval(timer);
        timers = [];
        client?.stop();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    it('drops a connection it has stopped hearing from, and connects again', async () => {
        const { connections, url } = await listen();

        start(url);
        await wait(SILENCE_LIMIT_MS * 3);

        expect(connections.length).toBeGreaterThan(1);
    });

    it('keeps a connection that is being pinged', async () => {
        const { connections, url } = await listen(socket => {
            timers.push(setInterval(() => socket.ping(), SILENCE_LIMIT_MS / 5));
        });

        start(url);
        await wait(SILENCE_LIMIT_MS * 4);

        expect(connections).toHaveLength(1);
    });

    it('keeps a connection that is sending messages', async () => {
        const { connections, url } = await listen(socket => {
            timers.push(setInterval(() => socket.send('{}'), SILENCE_LIMIT_MS / 5));
        });

        start(url);
        await wait(SILENCE_LIMIT_MS * 4);

        expect(connections).toHaveLength(1);
    });

    it('gives up on a connection that never gets past the handshake', async () => {
        // Accepts the TCP connection and answers nothing, as a dead path can.
        const sockets: Socket[] = [];
        server = createServer();
        server.on('upgrade', (_request, socket) => {
            sockets.push(socket as Socket);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

        start(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        await wait(SILENCE_LIMIT_MS * 3);

        expect(sockets.length).toBeGreaterThan(1);
        // An upgraded socket no longer belongs to the server, so closing the server would wait for it.
        client?.stop();
        for (const socket of sockets) socket.destroy();
    });
});
