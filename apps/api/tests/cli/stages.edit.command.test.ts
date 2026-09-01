import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// `wilson stages edit` is `wilson card edit` for the stage config: `GET /api/stages/config` for the
// current document, `$EDITOR` on it, `PUT /api/stages/config` with what came back. Same `editBody`
// underneath, so the same conventions — an empty buffer abandons, an unchanged one writes nothing —
// and the same real-spawned throwaway editor to drive it.
const { default: command } = await import('../../../../packages/cli/src/commands/stages/edit.command.js');

const run = (ctx: unknown, opts: { message?: string } = {}) => (command.run as unknown as Handler<{ message?: string }>)(opts, ctx, []);

const document = (yaml: string, id = '7') => ({ id, yaml, message: 'Imported', createdAt: '2026-09-01T10:00:00.000Z' });

const ORIGINAL_EDITOR = process.env.EDITOR;
const ORIGINAL_VISUAL = process.env.VISUAL;

const useFakeEditor = async (script: string): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'fake-editor-'));
    const scriptPath = join(dir, 'editor.js');
    await writeFile(scriptPath, script, 'utf8');
    delete process.env.VISUAL;
    process.env.EDITOR = `${process.execPath} ${scriptPath}`;
};

afterEach(() => {
    if (ORIGINAL_EDITOR === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = ORIGINAL_EDITOR;
    if (ORIGINAL_VISUAL === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = ORIGINAL_VISUAL;
});

describe('wilson stages edit', () => {
    it('reads the document, opens $EDITOR on it, and PUTs the changed text back with the message', async () => {
        await useFakeEditor(
            "const fs = require('fs'); const p = process.argv[2]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '    maxSteps: 80\\n');",
        );
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages:\n  - name: implementing\n')));
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages:\n  - name: implementing\n    maxSteps: 80\n', '8')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, { message: 'more steps' });

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/stages/config');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/stages/config');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('PUT');
        const sent = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
        expect(sent).toEqual({ yaml: 'stages:\n  - name: implementing\n    maxSteps: 80\n', message: 'more steps' });
        expect(logger.info).toHaveBeenCalledWith('stage config updated (version 8)');
    });

    it('reports "unchanged" and never calls PUT when the editor leaves the document exactly as it was', async () => {
        await useFakeEditor("const fs = require('fs'); const p = process.argv[2]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8'));");
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages: []\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('unchanged');
    });

    it('reports "nothing written" and never calls PUT when the editor leaves the document empty', async () => {
        await useFakeEditor("require('fs').writeFileSync(process.argv[2], '')");
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages: []\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('empty document — nothing written');
    });

    it('prints the validator reason and exits 1 when the API refuses the edited document', async () => {
        await useFakeEditor("const fs = require('fs'); const p = process.argv[2]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + 'broken');");
        fetchMock.mockResolvedValueOnce(jsonResponse(document('stages: []\n')));
        fetchMock.mockResolvedValueOnce(
            reasonResponse(400, 'the submitted stage config routes to states that do not exist: implementing.onPass → "nowhere"'),
        );
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('routes to states that do not exist'));
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
