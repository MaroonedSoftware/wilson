import { describe, expect, it } from 'vitest';
import { buildRunTrace } from '#modules/agent/run.trace.js';

describe('buildRunTrace', () => {
    it('counts every read, and names each distinct path once in first-read order', () => {
        const trace = buildRunTrace(['b.ts', 'a.ts', 'b.ts', undefined], undefined);

        expect(trace).toEqual({ reads: 4, readPaths: ['b.ts', 'a.ts'] });
    });

    it('bounds the paths, while the count still says how many reads there were', () => {
        const reads = Array.from({ length: 80 }, (_, i) => `src/${i}.ts`);

        const trace = buildRunTrace(reads, undefined);

        expect(trace.reads).toBe(80);
        expect(trace.readPaths).toHaveLength(50);
    });

    it('cuts the final message to its limit', () => {
        expect(buildRunTrace([], 'x'.repeat(3000)).finalMessage).toHaveLength(2000);
    });
});
