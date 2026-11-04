import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCtx, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

vi.mock('../../../../packages/cli/src/sign.in.js', () => ({
    withStepUp: async (_ctx: unknown, api: unknown, call: (client: unknown) => Promise<unknown>) => call(api),
}));

const { default: list } = await import('../../../../packages/cli/src/commands/rules/list.command.js');
const { default: add } = await import('../../../../packages/cli/src/commands/rules/add.command.js');
const { default: edit } = await import('../../../../packages/cli/src/commands/rules/edit.command.js');
const { default: rm } = await import('../../../../packages/cli/src/commands/rules/rm.command.js');

type Opts = { severity?: string; statement?: string; message?: string };
const invoke = (command: { run: unknown }, ctx: unknown, args: unknown[], opts: Opts = {}) =>
    (command.run as Handler<Opts>)(opts, ctx, args as string[]);

const RULE = {
    id: 'no-raw-sql',
    statement: 'Queries go through Kysely',
    paths: ['apps/api/src/**'],
    severity: 'blocker',
    revision: '4',
    createdAt: '2026-11-04T10:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
};

const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;

afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
});

describe('wilson rules list', () => {
    it('prints each rule', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([RULE]));
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        const { ctx } = buildCtx();

        expect(await invoke(list, ctx, [])).toBe(0);

        expect(write).toHaveBeenCalledWith(expect.stringContaining('no-raw-sql  blocker  apps/api/src/**'));
    });

    it('says so when there are none', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        expect(await invoke(list, ctx, [])).toBe(0);

        expect(logger.info).toHaveBeenCalledWith('no rules');
    });
});

describe('wilson rules add', () => {
    it('sends the id, statement and every glob, however the variadic arrives', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(RULE, 201));
        const { ctx } = buildCtx();

        expect(await invoke(add, ctx, ['no-raw-sql', 'Queries go through Kysely', ['apps/api/src/**', 'packages/**']], { severity: 'concern' })).toBe(
            0,
        );

        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('POST');
        expect(sentBody()).toEqual({
            id: 'no-raw-sql',
            statement: 'Queries go through Kysely',
            paths: ['apps/api/src/**', 'packages/**'],
            severity: 'concern',
        });
    });

    it("reports the API's reason when refused", async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(409, 'there is already a rule "no-raw-sql"'));
        const { ctx, logger } = buildCtx();

        expect(await invoke(add, ctx, ['no-raw-sql', 'x', '**'])).toBe(1);

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('already a rule'));
    });
});

describe('wilson rules edit', () => {
    it('sends only what changed', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(RULE));
        const { ctx } = buildCtx();

        expect(await invoke(edit, ctx, ['no-raw-sql', []], { severity: 'concern' })).toBe(0);

        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('PATCH');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/rules/no-raw-sql');
        expect(sentBody()).toEqual({ severity: 'concern' });
    });

    it('refuses a change to nothing without calling the API', async () => {
        const { ctx, logger } = buildCtx();

        expect(await invoke(edit, ctx, ['no-raw-sql'])).toBe(1);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('--statement'));
    });
});

describe('wilson rules rm', () => {
    it('deletes the rule', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        const { ctx, logger } = buildCtx();

        expect(await invoke(rm, ctx, ['no-raw-sql'])).toBe(0);

        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('DELETE');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/rules/no-raw-sql');
        expect(logger.info).toHaveBeenCalledWith('no-raw-sql: removed');
    });
});
