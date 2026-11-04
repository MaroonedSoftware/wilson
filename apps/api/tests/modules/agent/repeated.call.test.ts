import { describe, expect, it } from 'vitest';
import { REPEATED_CALL_LIMIT, RepeatedCallWatch, describeRepeatedCall } from '#modules/agent/repeated.call.js';

const repeat = (watch: RepeatedCallWatch, tool: string, input: unknown, times: number): void => {
    for (let call = 0; call < times; call++) watch.observe(tool, input);
};

describe('RepeatedCallWatch', () => {
    it('stays quiet up to the limit and names the call at it', () => {
        const watch = new RepeatedCallWatch();

        repeat(watch, 'Bash', { command: 'pnpm test' }, REPEATED_CALL_LIMIT - 1);
        expect(watch.loop).toBeUndefined();

        watch.observe('Bash', { command: 'pnpm test' });
        expect(watch.loop).toEqual({ tool: 'Bash', input: '{"command":"pnpm test"}', count: REPEATED_CALL_LIMIT });
    });

    it('treats a different tool or a different input as a different call', () => {
        const watch = new RepeatedCallWatch();

        repeat(watch, 'Read', { path: 'a' }, REPEATED_CALL_LIMIT - 1);
        repeat(watch, 'Read', { path: 'b' }, REPEATED_CALL_LIMIT - 1);
        repeat(watch, 'Grep', { path: 'a' }, REPEATED_CALL_LIMIT - 1);

        expect(watch.loop).toBeUndefined();
    });

    it('takes the same input in any key order, at any depth, as the same call', () => {
        const watch = new RepeatedCallWatch();

        repeat(watch, 'Tool', { a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } }, REPEATED_CALL_LIMIT - 1);
        watch.observe('Tool', { b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1, ignored: undefined });

        expect(watch.loop?.count).toBe(REPEATED_CALL_LIMIT);
    });

    it('keeps counting through other calls, so alternating between two is still seen', () => {
        const watch = new RepeatedCallWatch();

        for (let call = 0; call < REPEATED_CALL_LIMIT; call++) {
            expect(watch.loop).toBeUndefined();
            watch.observe('Read', { path: 'a' });
            watch.observe('Read', { path: 'b' });
        }

        expect(watch.loop?.input).toBe('{"path":"a"}');
    });

    it('clears the count on a successful write, so re-running tests after an edit is not a loop', () => {
        const watch = new RepeatedCallWatch();

        for (let edit = 0; edit < REPEATED_CALL_LIMIT * 3; edit++) {
            repeat(watch, 'Bash', { command: 'pnpm test' }, REPEATED_CALL_LIMIT - 1);
            watch.wrote('Edit', { path: 'a.ts', old: String(edit) });
        }

        expect(watch.loop).toBeUndefined();
    });

    it('clears nothing when a write only repeats the last one, which changed nothing', () => {
        const watch = new RepeatedCallWatch();

        // The first of them did change something, so the count starts from the second.
        for (let call = 0; call <= REPEATED_CALL_LIMIT; call++) {
            watch.observe('Write', { path: 'a.ts', content: 'same' });
            watch.wrote('Write', { path: 'a.ts', content: 'same' });
        }

        expect(watch.loop?.tool).toBe('Write');
    });

    it('counts a write that is never reported as having succeeded, as a refused one is', () => {
        const watch = new RepeatedCallWatch();

        repeat(watch, 'Write', { path: 'out-of-scope.ts', content: 'x' }, REPEATED_CALL_LIMIT);

        expect(watch.loop?.tool).toBe('Write');
    });

    it('keeps a loop it has seen, whatever is written afterwards', () => {
        const watch = new RepeatedCallWatch();

        repeat(watch, 'Bash', { command: 'pnpm test' }, REPEATED_CALL_LIMIT);
        watch.wrote('Edit', { path: 'a.ts' });

        expect(watch.loop?.tool).toBe('Bash');
    });

    it('copes with a call that has no input', () => {
        const watch = new RepeatedCallWatch();

        repeat(watch, 'Tool', undefined, REPEATED_CALL_LIMIT);

        expect(watch.loop?.input).toBe('null');
    });
});

describe('describeRepeatedCall', () => {
    it('names the call and the count, and no budget', () => {
        const text = describeRepeatedCall({ tool: 'Bash', input: '{"command":"pnpm test"}', count: 8 });

        expect(text).toContain('same Bash call 8 times');
        expect(text).toContain('pnpm test');
        expect(text).not.toMatch(/budget|wall.clock|steps/i);
    });

    it('quotes little enough of a long input that the whole message survives an attempt bullet', () => {
        const text = describeRepeatedCall({ tool: 'Write', input: 'x'.repeat(5000), count: 8 });

        expect(text.length).toBeLessThan(200);
    });
});
