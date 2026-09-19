import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson learnings set <file>` sends a file's contents as the new learnings document — `PUT
// /api/learnings` (AC6) — the one-shot path for importing a document written outside `$EDITOR`, or
// retiring every learning at once by pointing this at an empty file (which `wilson learnings edit`
// cannot express, since an empty editor buffer means "abandon" there).
const { default: command } = await import('../../../../packages/cli/src/commands/learnings/set.command.js');

const run = (ctx: unknown, file: string, opts: { message?: string } = {}) =>
    (command.run as unknown as Handler<{ message?: string }>)(opts, ctx, [file]);

const document = (markdown: string, id = '9') => ({ id, markdown, message: 'Set', createdAt: '2026-09-01T10:00:00.000Z' });

const writeTempFile = async (contents: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'learnings-set-'));
    const path = join(dir, 'learnings.md');
    await writeFile(path, contents, 'utf8');
    return path;
};

describe('wilson learnings set', () => {
    it('PUTs the file contents verbatim, with a message naming the file when none is given (AC6)', async () => {
        const path = await writeTempFile('# Learnings\n\nDo not do that.\n');
        fetchMock.mockResolvedValueOnce(jsonResponse(document('# Learnings\n\nDo not do that.\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, path);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/learnings');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('PUT');
        const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
        expect(sent).toEqual({ markdown: '# Learnings\n\nDo not do that.\n', message: `Set from ${path}` });
        expect(logger.info).toHaveBeenCalledWith(`learnings document updated from ${path} (version 9)`);
    });

    it('sends an explicit --message instead of the default', async () => {
        const path = await writeTempFile('some learnings\n');
        fetchMock.mockResolvedValueOnce(jsonResponse(document('some learnings\n')));
        const { ctx } = buildCtx();

        await run(ctx, path, { message: 'Imported from the old file' });

        const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
        expect(sent.message).toBe('Imported from the old file');
    });

    it('saves an empty file as a valid, empty document — the way to retire every learning at once', async () => {
        const path = await writeTempFile('');
        fetchMock.mockResolvedValueOnce(jsonResponse(document('')));
        const { ctx } = buildCtx();

        const result = await run(ctx, path);

        expect(result).toBe(0);
        const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
        expect(sent.markdown).toBe('');
    });

    it('fails on a file that cannot be read before calling the API at all', async () => {
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '/nonexistent/learnings.md');

        expect(result).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        const path = await writeTempFile('some learnings\n');
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, path);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
