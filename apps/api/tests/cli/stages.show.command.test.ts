import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson stages show` prints the stage config document — `GET /api/stages/config` — to stdout
// verbatim, so `wilson stages show > stages.yaml` produces exactly what `wilson stages set` accepts.
const { default: command } = await import('../../../../packages/cli/src/commands/stages/show.command.js');

const run = (ctx: unknown) => (command.run as unknown as Handler)({}, ctx, []);

const document = (yaml: string) => ({ id: '7', yaml, message: 'Imported', createdAt: '2026-09-01T10:00:00.000Z' });

let stdout: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout.push(String(chunk));
    return true;
});

afterEach(() => {
    stdout = [];
    stdoutSpy.mockClear();
});

describe('wilson stages show', () => {
    it('prints the document to stdout byte for byte, through GET /api/stages/config', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages:\n  - name: implementing\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/stages/config');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(stdout.join('')).toBe('stages:\n  - name: implementing\n');
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('terminates a document that lacks a trailing newline, and nothing else', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages: []')));
        const { ctx } = buildCtx();

        await run(ctx);

        expect(stdout.join('')).toBe('stages: []\n');
    });

    it('prints the API-supplied reason and exits 1 for a project with no config', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(404, 'this project has no stage config yet; run `wilson board init`'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('this project has no stage config yet; run `wilson board init`');
        expect(stdout).toEqual([]);
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
