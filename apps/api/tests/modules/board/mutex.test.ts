import { describe, expect, it } from 'vitest';
import { Mutex } from '#modules/board/mutex.js';

describe('Mutex', () => {
    it('serializes overlapping writers', async () => {
        const mutex = new Mutex();
        const order: string[] = [];

        const write = (label: string, delay: number) =>
            mutex.run(async () => {
                order.push(`${label}:start`);
                await new Promise(resolve => setTimeout(resolve, delay));
                order.push(`${label}:end`);
            });

        // The slow writer goes first: without the lock, b would start before a finished.
        await Promise.all([write('a', 20), write('b', 0)]);

        expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('keeps running later writers after one throws', async () => {
        const mutex = new Mutex();
        const failure = mutex.run(async () => {
            throw new Error('write failed');
        });

        // The caller still sees the rejection...
        await expect(failure).rejects.toThrow('write failed');
        // ...but a single failed write must not wedge the board for everything after it.
        await expect(mutex.run(async () => 'ok')).resolves.toBe('ok');
    });

    it('returns each writer its own result', async () => {
        const mutex = new Mutex();
        await expect(Promise.all([mutex.run(async () => 1), mutex.run(async () => 2)])).resolves.toEqual([1, 2]);
    });
});
