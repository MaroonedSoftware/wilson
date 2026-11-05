import { describe, expect, it } from 'vitest';
import { judgeDrift, parseAdapterReads, parseKinds, readAdapterReads, readBaseline, type CodexKinds } from '#tests/support/codex.protocol.js';

const baseline: CodexKinds = {
    notifications: ['item/started', 'warning'],
    requests: ['item/tool/call'],
    items: ['agentMessage', 'commandExecution'],
};
const reads: CodexKinds = { notifications: ['item/started'], requests: ['item/tool/call'], items: ['commandExecution'] };

describe('parseKinds', () => {
    it('reads each file for its own field, once each and sorted', () => {
        const kinds = parseKinds({
            notifications: `{ "method": "b", params: X } | { "method": "a", params: Y } | { "method": "b", params: Z }`,
            requests: `{ "method": "r", id: RequestId }`,
            items: `{ "type": "commandExecution", id: string } | { "type": "webSearch" } & WebSearchItem`,
        });

        expect(kinds).toEqual({ notifications: ['a', 'b'], requests: ['r'], items: ['commandExecution', 'webSearch'] });
    });
});

describe('parseAdapterReads', () => {
    it('tells requests the adapter answers from notifications it reads', () => {
        const reads = parseAdapterReads(`
            if (method === 'item/tool/call') return await callTool(params);
            if (method === 'item/started') itemStarted(params);
            if (item.type === 'agentMessage') summary = item.text;
        `);

        expect(reads.requests).toEqual(['item/tool/call']);
        expect(reads.notifications).toEqual(['item/started']);
        expect(reads.items).toContain('agentMessage');
    });

    it('counts the tool items, since that set is how the guard recognises a tool', () => {
        expect(parseAdapterReads('').items).toContain('mcpToolCall');
    });
});

describe('judgeDrift', () => {
    const with_ = (changes: Partial<CodexKinds>): CodexKinds => ({ ...baseline, ...changes });

    it('has nothing to say about the same protocol', () => {
        expect(judgeDrift(baseline, baseline, reads)).toEqual({ failures: [], notes: [] });
    });

    it('fails on a new item type, which would run past the guard', () => {
        const drift = judgeDrift(baseline, with_({ items: [...baseline.items, 'teleport'] }), reads);

        expect(drift.failures.join()).toContain('teleport');
    });

    it('fails on a new server request', () => {
        const drift = judgeDrift(baseline, with_({ requests: [...baseline.requests, 'ask/anything'] }), reads);

        expect(drift.failures.join()).toContain('ask/anything');
    });

    it('fails when a kind the adapter reads is gone', () => {
        const drift = judgeDrift(baseline, with_({ notifications: ['warning'] }), reads);

        expect(drift.failures.join()).toContain('item/started');
    });

    it('only notes a new notification, or the loss of a kind the adapter does not read', () => {
        const drift = judgeDrift(baseline, with_({ notifications: ['item/started', 'brand/new'], items: ['commandExecution'] }), reads);

        expect(drift.failures).toEqual([]);
        expect(drift.notes.join()).toContain('brand/new');
        expect(drift.notes.join()).toContain('warning');
        expect(drift.notes.join()).toContain('agentMessage');
    });
});

describe('the committed baseline', () => {
    it('still holds everything the adapter reads', async () => {
        const [baseline, reads] = await Promise.all([readBaseline(), readAdapterReads()]);

        expect(reads.requests.length).toBeGreaterThan(0);
        expect(reads.notifications.length).toBeGreaterThan(0);
        for (const field of ['notifications', 'requests', 'items'] as const) {
            expect(reads[field].filter(kind => !baseline[field].includes(kind))).toEqual([]);
        }
    });
});
