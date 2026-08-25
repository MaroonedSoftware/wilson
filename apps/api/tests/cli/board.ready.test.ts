import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '@maroonedsoftware/appconfig';

// `board.ready.ts` talks to Postgres through the `pg` driver directly, exactly the way
// `queue.reachable.ts` does — see that file's test for why mocking `pg.Client` is enough to exercise
// the check's own logic without a real database.
const connectMock = vi.fn();
const queryMock = vi.fn();
const endMock = vi.fn();

vi.mock('pg', () => ({
    default: {
        Client: class {
            connect = connectMock;
            query = queryMock;
            end = endMock;
        },
    },
}));

// Imported after the mock above is declared; vi.mock calls are hoisted above imports by vitest, so
// by the time this module (and transitively board.ready.ts) loads, `pg.Client` is already the stub.
const { boardReady } = await import('../../../../packages/cli/src/checks/board.ready.js');

type CheckResult = { ok: boolean; message: string; fixHint?: string };
type RunFn = (ctx: unknown) => Promise<CheckResult>;
const run = boardReady.run as unknown as RunFn;

const buildCtx = (values: Record<string, string>) => ({ config: new AppConfig(values) });

const validStagesYaml = [
    'stages:',
    '  - name: implementing',
    '    mode: agent',
    '    model: claude-test-model',
    '    instructions: do the thing',
    '    onPass: merged',
    '    onFail: implementing',
    '',
].join('\n');

// The exact shape `board init` used to write, before this card's fix — `onPass` names a stage that
// is not configured, and `onFail` names one that is neither configured nor a terminal state. This is
// the config `assertRoutesResolve` rejects.
const unresolvableStagesYaml = [
    'stages:',
    '  - name: implementing',
    '    mode: agent',
    '    model: claude-test-model',
    '    instructions: do the thing',
    '    onPass: testing',
    '    onFail: planning',
    '',
].join('\n');

describe('boardReady', () => {
    let root: string;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-ready-'));
        root = join(base, 'board');
        await mkdir(join(root, 'config'), { recursive: true });
        endMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('reports an unparseable stage config as failing, naming the reason, and never touches postgres', async () => {
        await writeFile(join(root, 'config', 'stages.yaml'), unresolvableStagesYaml, 'utf8');

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toContain(`${root}/config/stages.yaml is invalid`);
        // The specific reason, not just "invalid" — this is what makes the check useful at the
        // exact moment someone is asking what is wrong.
        expect(result.message).toContain('testing');
        expect(result.fixHint).toContain('human-write-only');
        expect(connectMock).not.toHaveBeenCalled();
    });

    it('reports failure for stage config that is not even valid YAML shape (missing required fields)', async () => {
        await writeFile(join(root, 'config', 'stages.yaml'), 'stages:\n  - name: onlyName\n', 'utf8');

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        expect(result.ok).toBe(false);
        expect(result.message).toContain('is invalid');
        expect(connectMock).not.toHaveBeenCalled();
    });

    it('moves past the stage-config check to the database check once the config is valid', async () => {
        await writeFile(join(root, 'config', 'stages.yaml'), validStagesYaml, 'utf8');
        connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await run(buildCtx({ PROJECT_BOARD_ROOT: root }));

        // A valid config must not be reported as the problem — the failure below is the database's,
        // reached only because the stage-config guard let this run through.
        expect(result.ok).toBe(false);
        expect(result.message).toContain('board tables unavailable');
        expect(connectMock).toHaveBeenCalledTimes(1);
    });
});
