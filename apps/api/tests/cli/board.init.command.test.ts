import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BoardConfig, NON_STAGE_STATES, loadStages } from '@wilson/api/cli-bootstrap';

// `init.command.ts` wraps its handler in johnny5's `requireContainer`, exactly like the other CLI
// commands under test here — see `run.command.test.ts` for why the stub below is enough to make the
// wrapped handler directly callable.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

const { default: command } = await import('../../../../packages/cli/src/commands/board/init.command.js');

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;
const run = command.run as unknown as Handler;

const buildCtx = (boardRoot: string) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { boardRoot } as unknown as BoardConfig;
    const container = {
        get: (token: unknown) => {
            if (token === BoardConfig) return config;
            throw new Error(`buildCtx: unexpected token ${String(token)}`);
        },
    };
    return { ctx: { container, logger }, logger };
};

describe('wilson board init', () => {
    it('scaffolds a stages.yaml that loadStages accepts unedited, with every route resolving', async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-init-'));
        const boardRoot = join(base, 'board');
        const { ctx } = buildCtx(boardRoot);

        const result = await run({}, ctx, []);

        expect(result).toBe(0);

        // This is the acceptance bar itself: `loadStages` must accept the exact file `board init`
        // just wrote, with no hand-editing in between. On the old template (`onPass: testing`,
        // `onFail: planning` — neither a configured stage nor a non-stage state) `loadStages` throws
        // a `StageConfigError` from `assertRoutesResolve` right here, before any assertion below runs.
        const stages = await loadStages(boardRoot);

        expect(stages.stages.length).toBeGreaterThan(0);
        const known = new Set<string>([...NON_STAGE_STATES, ...stages.stages.map(s => s.name)]);
        for (const stage of stages.stages) {
            expect(known.has(stage.onPass)).toBe(true);
            expect(known.has(stage.onFail)).toBe(true);
        }
    });

    it('leaves an already-initialised board untouched', async () => {
        const base = await mkdtemp(join(tmpdir(), 'board-init-'));
        const boardRoot = join(base, 'board');
        const { ctx: first } = buildCtx(boardRoot);
        await run({}, first, []);
        const before = await loadStages(boardRoot);

        const { ctx: second, logger } = buildCtx(boardRoot);
        const result = await run({}, second, []);

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already initialised'));
        const after = await loadStages(boardRoot);
        expect(after).toEqual(before);
    });
});
