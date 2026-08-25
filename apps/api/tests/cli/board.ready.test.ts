import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { connectionRefused, fetchMock, jsonResponse, reasonResponse, urlOf } from './sdk-fetch.helper.js';

// Card 0078: `board.ready.ts` no longer opens `pg` directly (that was the CLI's own container-backed
// board access). Whether `PROJECT_BOARD_ROOT` is set and whether `stages.yaml` exists under it are
// still filesystem facts this check reads for itself; whether the board actually has cards is now a
// question answered by calling the API, the same way any other command does — see the module doc on
// `boardReady`.
const { boardReady } = await import('../../../../packages/cli/src/checks/board.ready.js');

type CheckResult = { ok: boolean; message: string; fixHint?: string };
type RunFn = (ctx: unknown) => Promise<CheckResult>;
const run = boardReady.run as unknown as RunFn;

const buildCtx = (values: Record<string, string>) => ({ config: new AppConfig(values) });

describe('boardReady', () => {
    it('fails, naming the fix, when PROJECT_BOARD_ROOT is not set — and never calls the API', async () => {
        const result = await run(buildCtx({}));

        expect(result.ok).toBe(false);
        expect(result.message).toBe('PROJECT_BOARD_ROOT is not set');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails, naming the missing file, when the board root has no config/stages.yaml — and never calls the API', async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-ready-'));
        const root = join(base, 'board');

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`no stage config at ${root}/config/stages.yaml`);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('calls the API for the card count once the local config exists, and reports it alongside the config path', async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-ready-'));
        const root = join(base, 'board');
        await mkdir(join(root, 'config'), { recursive: true });
        await writeFile(join(root, 'config', 'stages.yaml'), 'stages: []\n', 'utf8');
        fetchMock.mockResolvedValueOnce(jsonResponse([{ id: '0001' }, { id: '0002' }]));

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        expect(result.ok).toBe(true);
        expect(result.message).toBe(`2 cards · stage config at ${root}/config/stages.yaml`);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards');
    });

    it('fails with a fix hint when the board has no cards yet', async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-ready-'));
        const root = join(base, 'board');
        await mkdir(join(root, 'config'), { recursive: true });
        await writeFile(join(root, 'config', 'stages.yaml'), 'stages: []\n', 'utf8');
        fetchMock.mockResolvedValueOnce(jsonResponse([]));

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toBe('no cards on the board');
        expect(result.fixHint).toContain('wilson board import');
    });

    it('reports the API-supplied reason for a broken config, discovered only once the API call fails', async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-ready-'));
        const root = join(base, 'board');
        await mkdir(join(root, 'config'), { recursive: true });
        await writeFile(join(root, 'config', 'stages.yaml'), 'stages: []\n', 'utf8');
        fetchMock.mockResolvedValueOnce(reasonResponse(500, 'stages.yaml is invalid: onPass "testing" is not a configured stage'));

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toBe('stages.yaml is invalid: onPass "testing" is not a configured stage');
        expect(result.fixHint).toContain('wilson run');
    });

    it('reports a refused connection with the same "is it running?" message every other command gives', async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-ready-'));
        const root = join(base, 'board');
        await mkdir(join(root, 'config'), { recursive: true });
        await writeFile(join(root, 'config', 'stages.yaml'), 'stages: []\n', 'utf8');
        fetchMock.mockImplementationOnce(connectionRefused);

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toContain('is it running?');
    });
});
