import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { KEEPALIVE_MS, MAX_MISSED_PONGS, WorkerConnection } from '#modules/worker/worker.connection.js';

class FakeSocket extends EventEmitter {
    ping = vi.fn();
    terminate = vi.fn();
    send = vi.fn();
}

describe('a worker connection’s keepalive', () => {
    let socket: FakeSocket;
    let connection: WorkerConnection;

    const tick = (intervals = 1) => vi.advanceTimersByTime(KEEPALIVE_MS * intervals);

    beforeEach(() => {
        vi.useFakeTimers();
        socket = new FakeSocket();
        connection = new WorkerConnection('my-mac', { workerVersion: '0.0.1', platform: 'linux' }, socket as unknown as WebSocket);
    });

    afterEach(() => {
        socket.emit('close', 1000, Buffer.alloc(0));
        vi.useRealTimers();
    });

    it('keeps a connection through as many unanswered pings as it allows', () => {
        tick(MAX_MISSED_PONGS);

        expect(socket.ping).toHaveBeenCalledTimes(MAX_MISSED_PONGS);
        expect(socket.terminate).not.toHaveBeenCalled();
        expect(connection.open).toBe(true);
    });

    it('closes a connection one interval after that, naming how long it waited', async () => {
        const waiting = connection.call({ op: 'ping' });

        tick(MAX_MISSED_PONGS + 1);

        expect(socket.terminate).toHaveBeenCalledTimes(1);
        expect(connection.open).toBe(false);
        await expect(waiting).rejects.toThrow('no answer to a keepalive ping in 60s');
    });

    it('starts counting again after a pong', () => {
        tick(MAX_MISSED_PONGS);
        socket.emit('pong');
        tick(MAX_MISSED_PONGS);

        expect(connection.open).toBe(true);
    });

    it('starts counting again after any message, since one shows the worker is there', () => {
        tick(MAX_MISSED_PONGS);
        socket.emit('message', Buffer.from('{}'), false);
        tick(MAX_MISSED_PONGS);

        expect(connection.open).toBe(true);
    });
});
