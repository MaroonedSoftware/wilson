import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptCancelledError } from '@maroonedsoftware/johnny5';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0113: `wilson card split <id>` fetches a card's most recent scope-check refusal
// (`GET .../division`), renders it, lets an operator add to each piece's reported `dependsOn`
// before anything is written, confirms once showing everything, and only then calls
// `POST .../split` to create the pieces. Only `prompts.confirm`/`prompts.multiselect` are replaced
// here — an interactive clack prompt would otherwise block on the test's stdin. `PromptCancelledError`
// and `unwrap` stay real, so the command's own `unwrap(await prompts...(...))` calls run exactly as
// they do in production (the same idiom `plan.command.test.ts` uses for `prompts.confirm` alone).
const { confirmMock, multiselectMock } = vi.hoisted(() => ({ confirmMock: vi.fn(), multiselectMock: vi.fn() }));
vi.mock('@maroonedsoftware/johnny5', async importOriginal => {
    const actual = await importOriginal<typeof import('@maroonedsoftware/johnny5')>();
    return { ...actual, prompts: { ...actual.prompts, confirm: confirmMock, multiselect: multiselectMock } };
});

const { default: command } = await import('../../../../packages/cli/src/commands/card/split.command.js');

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

const division = (overrides: Partial<{ reason: string; pieces: unknown[] }> = {}) => ({
    reason: 'the plan repeats "endpoint" five times',
    pieces: [
        { title: 'Piece A', tasks: ['task 1'], delivers: 'delivers A on its own', dependsOn: [] },
        { title: 'Piece B', tasks: ['task 2'], delivers: 'delivers B on its own', dependsOn: ['Piece A'] },
    ],
    ...overrides,
});

const cardDetail = (overrides: Partial<{ id: string; title: string; stage: string; body: string }> = {}) => ({
    id: '0200',
    title: 'a piece',
    stage: 'planning',
    dependsOn: [],
    needsHuman: false,
    body: 'stub body',
    sections: {},
    ...overrides,
});

const splitResult = () =>
    jsonResponse(
        {
            origin: cardDetail({ id: '0111', title: 'Big card', body: 'origin body\n\n---\n\nSplit into: 0200, 0201.' }),
            pieces: [cardDetail({ id: '0200', title: 'Piece A' }), cardDetail({ id: '0201', title: 'Piece B' })],
        },
        201,
    );

describe('wilson card split', () => {
    beforeEach(() => {
        confirmMock.mockReset();
        multiselectMock.mockReset();
    });

    it('reads the division, confirms the reported dependencies as-is, and creates the pieces on approval', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(division())); // GET division
        fetchMock.mockResolvedValueOnce(splitResult()); // POST split
        multiselectMock.mockImplementation(async (opts: { initialValues: string[] }) => opts.initialValues);
        confirmMock.mockResolvedValue(true);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0111');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0111/division');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0111/split');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('POST');

        const body = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
        expect(body).toEqual({
            pieces: [
                { title: 'Piece A', tasks: ['task 1'], delivers: 'delivers A on its own', dependsOn: [] },
                { title: 'Piece B', tasks: ['task 2'], delivers: 'delivers B on its own', dependsOn: ['Piece A'] },
            ],
        });

        expect(logger.info).toHaveBeenCalledWith('0200 created in planning: Piece A');
        expect(logger.info).toHaveBeenCalledWith('0201 created in planning: Piece B');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('0111 was not moved or dropped'));
    });

    it("prints each piece's tasks, delivers, and reported dependsOn — including '(none)' for an empty one — before asking anything", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(division()));
        multiselectMock.mockImplementation(async (opts: { initialValues: string[] }) => opts.initialValues);
        confirmMock.mockResolvedValue(false); // decline, so nothing beyond the read-and-render happens
        const { ctx, logger } = buildCtx();

        await run(ctx, '0111');

        expect(logger.info).toHaveBeenCalledWith('Piece A');
        expect(logger.info).toHaveBeenCalledWith('  - task 1');
        expect(logger.info).toHaveBeenCalledWith('  delivers: delivers A on its own');
        expect(logger.info).toHaveBeenCalledWith('  reported dependsOn: (none)');
        expect(logger.info).toHaveBeenCalledWith('  reported dependsOn: Piece A');
    });

    it('lets the operator add a dependency scope-check never reported, and records exactly what was chosen — not what was reported', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(division()));
        fetchMock.mockResolvedValueOnce(splitResult());
        multiselectMock.mockImplementation(async (opts: { message: string; initialValues: string[] }) => {
            // Piece A reported no dependency at all; the operator adds one here.
            if (opts.message.startsWith('Piece A')) return ['Piece B'];
            return opts.initialValues;
        });
        confirmMock.mockResolvedValue(true);
        const { ctx, logger } = buildCtx();

        await run(ctx, '0111');

        const body = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body) as { pieces: Array<{ title: string; dependsOn: string[] }> };
        expect(body.pieces.find(p => p.title === 'Piece A')!.dependsOn).toEqual(['Piece B']);
        // The confirmation shown before the write reflects the operator's addition, not the report.
        expect(logger.info).toHaveBeenCalledWith('  Piece A — depends on: Piece B');
    });

    it('declines and writes nothing when the operator cancels the dependency prompt, never reaching the confirmation', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(division()));
        multiselectMock.mockRejectedValueOnce(new PromptCancelledError());
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0111');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('declined. Nothing written.');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(confirmMock).not.toHaveBeenCalled();
    });

    it('declines the confirmation, calling GET .../division but never POST .../split', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(division()));
        multiselectMock.mockImplementation(async (opts: { initialValues: string[] }) => opts.initialValues);
        confirmMock.mockResolvedValue(false);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0111');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('declined. Nothing written.');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('exits non-zero with the API-supplied reason, and never prompts, when the card has no scope-check refusal on record', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '0111 has no scope-check refusal on record — nothing to split'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0111');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0111 has no scope-check refusal on record — nothing to split');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(multiselectMock).not.toHaveBeenCalled();
        expect(confirmMock).not.toHaveBeenCalled();
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0111');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
        expect(multiselectMock).not.toHaveBeenCalled();
    });
});
