import { describe, expect, it } from 'vitest';
import { FromWorker, parseFrame, ToWorker } from '../src/worker.messages.js';

describe('parseFrame', () => {
    it('parses a message of the direction asked for', () => {
        expect(parseFrame(FromWorker, JSON.stringify({ type: 'hello', protocol: 1, workerVersion: '0.0.1', platform: 'linux' }))).toEqual({
            type: 'hello',
            protocol: 1,
            workerVersion: '0.0.1',
            platform: 'linux',
        });
        expect(parseFrame(ToWorker, JSON.stringify({ type: 'call', id: 'a', call: { op: 'stat', path: '/x' } }))).toEqual({
            type: 'call',
            id: 'a',
            call: { op: 'stat', path: '/x' },
        });
    });

    it('tells a failed result from a successful one', () => {
        const failed = parseFrame(FromWorker, JSON.stringify({ type: 'result', id: 'a', ok: false, error: { message: 'boom', code: 'ENOENT' } }));
        expect(failed).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
    });

    it('rejects what is not JSON, a message of the other direction, and an unknown op', () => {
        expect(parseFrame(FromWorker, 'not json')).toBeUndefined();
        expect(parseFrame(FromWorker, JSON.stringify({ type: 'welcome', host: 'h', projects: [] }))).toBeUndefined();
        expect(parseFrame(ToWorker, JSON.stringify({ type: 'call', id: 'a', call: { op: 'format-disk' } }))).toBeUndefined();
    });
});
