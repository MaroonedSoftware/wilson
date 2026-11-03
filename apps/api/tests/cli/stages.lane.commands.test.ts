import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCtx, fetchMock, jsonResponse, methodOf, urlOf, type Handler } from './sdk-fetch.helper.js';

vi.mock('../../../../packages/cli/src/sign.in.js', () => ({
    withStepUp: async (_ctx: unknown, api: unknown, call: (client: unknown) => Promise<unknown>) => call(api),
}));

const { default: set } = await import('../../../../packages/cli/src/commands/stages/set.command.js');
const { default: show } = await import('../../../../packages/cli/src/commands/stages/show.command.js');
const { default: history } = await import('../../../../packages/cli/src/commands/stages/history.command.js');

type Opts = { message?: string; unset?: boolean; limit?: number };
const invoke = (command: { run: unknown }, ctx: unknown, args: string[], opts: Opts = {}) => (command.run as Handler<Opts>)(opts, ctx, args);

const LANE = {
    name: 'review',
    position: 5,
    mode: 'agent',
    worktree: 'readonly',
    onPass: 'ready',
    onFail: 'implementing',
    model: 'claude-opus-5-5',
    instructions: 'Find what is wrong.',
    settings: { maxSteps: 150 },
};

const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;

afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
});

describe('wilson stages set <lane> <field>', () => {
    it('sends a setting as JSON when it reads as JSON', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(LANE));
        const { ctx } = buildCtx();

        expect(await invoke(set, ctx, ['review', 'maxSteps', '200'])).toBe(0);

        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('PATCH');
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/stages/lanes/review');
        expect(sentBody()).toMatchObject({ settings: { maxSteps: 200 } });
    });

    it('sends a column as text, even when it reads as JSON', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(LANE));
        const { ctx } = buildCtx();

        expect(await invoke(set, ctx, ['review', 'instructions', '200'])).toBe(0);

        expect(sentBody()).toMatchObject({ instructions: '200' });
    });

    it('removes a setting with --unset, and refuses to unset a column', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(LANE));
        const { ctx } = buildCtx();

        expect(await invoke(set, ctx, ['review', 'maxSteps'], { unset: true })).toBe(0);
        expect(sentBody()).toMatchObject({ settings: { maxSteps: null } });

        expect(await invoke(set, ctx, ['review', 'onPass'], { unset: true })).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses a field with no value, sending nothing', async () => {
        const { ctx } = buildCtx();

        expect(await invoke(set, ctx, ['review', 'maxSteps'])).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('wilson stages show <lane>', () => {
    it('prints the lane, and fails naming the lanes there are for one that is not', async () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        fetchMock.mockResolvedValue(jsonResponse([LANE]));
        const { ctx, logger } = buildCtx();

        expect(await invoke(show, ctx, ['review'])).toBe(0);
        const printed = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(printed).toContain('onFail: implementing');
        expect(printed).toContain('Find what is wrong.');

        fetchMock.mockResolvedValue(jsonResponse([LANE]));
        expect(await invoke(show, ctx, ['nope'])).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('have: review'));
    });
});

describe('wilson stages history', () => {
    it('lists changes, labelling a project-wide one', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                { id: '2', lane: 'review', message: 'more steps', createdAt: '2026-11-03T10:00:00.000Z' },
                { id: '1', message: 'Imported', createdAt: '2026-11-03T09:00:00.000Z' },
            ]),
        );
        const { ctx, logger } = buildCtx();

        expect(await invoke(history, ctx, [])).toBe(0);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('review  more steps'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('(project)  Imported'));
    });
});
