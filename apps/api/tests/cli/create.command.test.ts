import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `create.command.ts` off `container.get(...)`/`nextCardId` and onto `@wilson/sdk`.
// The id used to be computed locally from `board.list()`; now the API assigns it
// (`api.board.createCard`), and this command only opens `$EDITOR` on the skeleton and reports the id
// the response carries back. `$EDITOR` handling itself stays local (out of scope for this card), so
// these tests drive it with a real spawned process — a tiny throwaway script standing in for the
// operator's editor — rather than mocking `node:child_process`, to exercise the actual
// spawn/write/read round trip `editBody` performs.
const { default: command } = await import('../../../../packages/cli/src/commands/card/create.command.js');

type CreateOpts = { stage?: string };
const run = (ctx: unknown, title: string, opts: CreateOpts = {}) => (command.run as unknown as Handler<CreateOpts>)(opts, ctx, [title]);

const ORIGINAL_EDITOR = process.env.EDITOR;
const ORIGINAL_VISUAL = process.env.VISUAL;

/** Point $EDITOR at a throwaway node script that runs against the file `editBody` opened. */
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

describe('wilson card create', () => {
    it('opens $EDITOR on the skeleton, and reports the id the API assigned once the editor exits leaving text', async () => {
        // A no-op editor: it exits without touching the file, so the skeleton text `editBody` wrote
        // survives — the same as an operator saving a file unmodified.
        await useFakeEditor('');
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0042', title: 'do the thing', stage: 'parking-lot', dependsOn: [], needsHuman: false }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, 'do the thing');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
        expect(sent.title).toBe('do the thing');
        expect(sent.stage).toBe('parking-lot');
        expect(sent.body).toContain('## Goal');
        expect(logger.info).toHaveBeenCalledWith('0042 created in parking-lot');
    });

    it('creates in the stage named by --stage instead of the default parking-lot', async () => {
        await useFakeEditor('');
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: '0043', title: 'x', stage: 'planning', dependsOn: [], needsHuman: false }));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, 'x', { stage: 'planning' });

        expect(result).toBe(0);
        const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
        expect(sent.stage).toBe('planning');
        expect(logger.info).toHaveBeenCalledWith('0043 created in planning');
    });

    it('does not call the API and reports the card was not created when the editor leaves the body empty', async () => {
        await useFakeEditor("require('fs').writeFileSync(process.argv[2], '')");
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, 'abandoned');

        expect(result).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith('empty body — card not created');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        await useFakeEditor('');
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, 'x');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
