import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `$EDITOR` is the one thing a test cannot drive, so the editor is stubbed. Everything else runs,
// down to `fetch` under the real `WilsonSdk`, as in `merge.command.test.ts`.
const editBody = vi.fn<(initial: string, name: string) => Promise<string | undefined>>();
vi.mock('#src/commands/card/editor.js', () => ({ editBody }));

const { default: command } = await import('#src/commands/stages/instructions.command.js');

type Handler = (opts: Record<string, unknown>, ctx: unknown, args: unknown[]) => Promise<number | void>;

const challenge = { name: 'challenge', on: 'revise', instructions: 'Refute each blocker.', maxSteps: 40 };
const other = { name: 'other', on: 'approve', instructions: 'Something else.' };
const lane = { name: 'review', instructions: "The lane's own prompt.", settings: { maxSteps: 150, steps: [challenge, other] } };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    editBody.mockReset();
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = (init?.method ?? 'GET') === 'GET' ? [lane] : lane;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const buildCtx = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { ctx: { config: { get: (_key: string, fallback: string) => fallback }, env: {}, logger }, logger };
};

const run = (ctx: unknown, opts: Record<string, unknown>) => (command.run as unknown as Handler)(opts, ctx, ['review']);

/** What the one write sent to the lane. */
const patched = (): Record<string, unknown> => {
    const writes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    return JSON.parse((writes[0]![1] as RequestInit).body as string) as Record<string, unknown>;
};

describe('wilson stages instructions', () => {
    it("writes the lane's own instructions when no step is named", async () => {
        editBody.mockResolvedValueOnce('A new prompt.');
        const { ctx } = buildCtx();

        expect(await run(ctx, {})).toBe(0);

        expect(editBody.mock.calls[0]![0]).toBe("The lane's own prompt.");
        expect(patched()).toEqual({ instructions: 'A new prompt.', message: 'Edited review instructions' });
    });

    it("writes a step's text to that step, leaving the lane's prompt and the other steps alone", async () => {
        editBody.mockResolvedValueOnce('Refute harder.');
        const { ctx } = buildCtx();

        expect(await run(ctx, { step: 'challenge' })).toBe(0);

        expect(editBody.mock.calls[0]![0]).toBe('Refute each blocker.');
        const body = patched();
        expect(body).not.toHaveProperty('instructions');
        expect(body.settings).toEqual({ steps: [{ ...challenge, instructions: 'Refute harder.' }, other] });
        expect(body.message).toBe('Edited review step challenge instructions');
    });

    it('refuses a step the lane does not have', async () => {
        const { ctx, logger } = buildCtx();

        expect(await run(ctx, { step: 'nope' })).toBe(1);

        expect(logger.error).toHaveBeenCalledWith('review has no step named "nope" (have: challenge, other)');
        expect(editBody).not.toHaveBeenCalled();
    });

    it('writes nothing for an unchanged step', async () => {
        editBody.mockResolvedValueOnce('Refute each blocker.');
        const { ctx } = buildCtx();

        expect(await run(ctx, { step: 'challenge' })).toBe(0);

        expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(0);
    });
});
