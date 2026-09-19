import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson learnings show` prints the learnings document — `GET /api/learnings` — to stdout
// verbatim, so `wilson learnings show > learnings.md` produces exactly what `wilson learnings set`
// accepts. Mirrors `wilson stages show`, with one difference: a project with no document yet is not
// a 404 here (AC3) — the API answers 200 with an empty document, and this command prints nothing.
const { default: command } = await import('../../../../packages/cli/src/commands/learnings/show.command.js');

const run = (ctx: unknown) => (command.run as unknown as Handler)({}, ctx, []);

const document = (markdown: string, message = 'Imported') => ({ id: '7', markdown, message, createdAt: '2026-09-01T10:00:00.000Z' });

let stdout: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout.push(String(chunk));
    return true;
});

afterEach(() => {
    stdout = [];
    stdoutSpy.mockClear();
});

describe('wilson learnings show', () => {
    it('prints the document to stdout byte for byte, through GET /api/learnings', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(document('# Learnings\n\nDo not do that.\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/learnings');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(stdout.join('')).toBe('# Learnings\n\nDo not do that.\n');
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('terminates a document that lacks a trailing newline, and nothing else', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(document('no trailing newline')));
        const { ctx } = buildCtx();

        await run(ctx);

        expect(stdout.join('')).toBe('no trailing newline\n');
    });

    it('prints nothing and exits 0 for a project with no learnings document yet, rather than refusing (AC3)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(document('', '')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(stdout).toEqual([]);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
