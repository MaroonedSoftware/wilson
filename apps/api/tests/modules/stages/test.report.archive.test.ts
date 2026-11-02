import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveTestReport } from '#modules/stages/test.report.archive.js';

describe('archiveTestReport', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'test-report-archive-'));
    });

    afterEach(() => {
        vi.useRealTimers();
        rmSync(root, { recursive: true, force: true });
    });

    it("writes the report beside the card's other run files and answers where", async () => {
        const path = await archiveTestReport(root, '0007', 'testing', '{"numFailedTests":1}');

        expect(path.startsWith(join(root, 'cards', '0007', 'test-reports'))).toBe(true);
        expect(path.endsWith('-testing.json')).toBe(true);
        expect(readFileSync(path, 'utf8')).toBe('{"numFailedTests":1}');
    });

    it('keeps only the five newest reports', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        for (let run = 1; run <= 7; run++) {
            vi.setSystemTime(new Date(2026, 10, 2, 12, run));
            await archiveTestReport(root, '0007', 'testing', String(run));
        }

        const dir = join(root, 'cards', '0007', 'test-reports');
        const contents = readdirSync(dir)
            .sort()
            .map(name => readFileSync(join(dir, name), 'utf8'));
        expect(contents).toEqual(['3', '4', '5', '6', '7']);
    });
});
