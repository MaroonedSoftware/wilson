import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `edit.command.ts` off `container.get(...)` and onto `@wilson/sdk`. It used to
// `board.read(cardId)` and `board.write(cardId, ..., card => ({...card, body}))`; now it calls
// `GET /api/cards/:id` for the current body and `PATCH /api/cards/:id` (`api.board.editCardBody`) to
// save it. `$EDITOR` handling itself stays local (out of scope for this card), so these tests drive it
// with a real spawned throwaway script rather than mocking `node:child_process`, exercising the actual
// spawn/write/read round trip `editBody` performs against the card's real current body.
const { default: command } = await import('../../../../packages/cli/src/commands/card/edit.command.js');

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

const detail = (body: string) => ({ id: '0001', title: 'x', stage: 'implementing', dependsOn: [], needsHuman: false, body });

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

describe('wilson card edit', () => {
    it('reads the card, opens $EDITOR on its body, and PATCHes the changed text back', async () => {
        // Appends to whatever `editBody` wrote to the file — i.e. to the card's fetched body —
        // simulating an operator who actually changed something.
        await useFakeEditor(
            "const fs = require('fs'); const p = process.argv[2]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\\nedited');",
        );
        fetchMock.mockResolvedValueOnce(jsonResponse(detail('## Goal\n\noriginal\n')));
        fetchMock.mockResolvedValueOnce(jsonResponse(detail('## Goal\n\noriginal\n\nedited')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0001');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0001');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('PATCH');
        const sent = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
        expect(sent.body).toBe('## Goal\n\noriginal\n\nedited');
        expect(logger.info).toHaveBeenCalledWith('0001 updated');
    });

    it('reports "unchanged" and never calls PATCH when the editor leaves the body exactly as it was', async () => {
        // Reads back and writes the exact same content it was handed — the editor equivalent of
        // opening a file and saving without changing anything.
        await useFakeEditor("const fs = require('fs'); const p = process.argv[2]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8'));");
        fetchMock.mockResolvedValueOnce(jsonResponse(detail('unchanged body\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('unchanged');
    });

    it('reports "nothing written" and never calls PATCH when the editor leaves the body empty', async () => {
        await useFakeEditor("require('fs').writeFileSync(process.argv[2], '')");
        fetchMock.mockResolvedValueOnce(jsonResponse(detail('some body\n')));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('empty body — nothing written');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
