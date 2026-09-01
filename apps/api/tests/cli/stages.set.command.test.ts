import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson stages set <file>` sends a file's contents as the new stage config — `PUT /api/stages/config`
// — the one-shot path for importing a board repo's `config/stages.yaml`, or an edit made outside
// `$EDITOR`. The file is read locally and sent as-is; validation is the API's.
const { default: command } = await import('../../../../packages/cli/src/commands/stages/set.command.js');

const run = (ctx: unknown, file: string, opts: { message?: string } = {}) =>
    (command.run as unknown as Handler<{ message?: string }>)(opts, ctx, [file]);

const document = (yaml: string, id = '9') => ({ id, yaml, message: 'Set', createdAt: '2026-09-01T10:00:00.000Z' });

const writeTempFile = async (contents: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'stages-set-'));
    const path = join(dir, 'stages.yaml');
    await writeFile(path, contents, 'utf8');
    return path;
};

describe('wilson stages set', () => {
    it('PUTs the file contents verbatim, with a message naming the file when none is given', async () => {
        const path = await writeTempFile('# the config\nstages:\n  - name: implementing\n');
        fetchMock.mockResolvedValueOnce(jsonResponse(document('# the config\nstages:\n  - name: implementing\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, path);

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/stages/config');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('PUT');
        const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
        expect(sent).toEqual({ yaml: '# the config\nstages:\n  - name: implementing\n', message: `Set from ${path}` });
        expect(logger.info).toHaveBeenCalledWith(`stage config updated from ${path} (version 9)`);
    });

    it('sends an explicit --message instead of the default', async () => {
        const path = await writeTempFile('stages: []\n');
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages: []\n')));
        const { ctx } = buildCtx();

        await run(ctx, path, { message: 'Imported from the board repo' });

        const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
        expect(sent.message).toBe('Imported from the board repo');
    });

    it('prints the validator reason and exits 1 when the API refuses the document', async () => {
        const path = await writeTempFile('stages: [\n');
        fetchMock.mockResolvedValueOnce(reasonResponse(400, 'the submitted stage config is not valid YAML: unexpected end'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, path);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is not valid YAML'));
    });

    it('fails on a file that cannot be read before calling the API at all', async () => {
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '/nonexistent/stages.yaml');

        expect(result).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        const path = await writeTempFile('stages: []\n');
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, path);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
