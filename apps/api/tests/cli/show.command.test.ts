import { describe, expect, it } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0078 ports `show.command.ts` off `container.get(...)` and onto `@wilson/sdk`. `retries` and
// `planVersionId` — the fields the old suite's "pinned-plan line" tested — are frontmatter the board
// API's wire contract does not expose (`CardSummary`/`CardDetail` in `@wilson/sdk`, card 0080's
// contract); they dropped out of this view along with the container it used to read them from, and
// restoring them is a contract change for a card of its own, not something a client can add back. This
// suite is rewritten around what the ported command actually shows now: the card, its computed files
// in scope and time-in-stage (`board-view.ts`'s local reimplementations), and its recent events —
// plain text or `--json`.
const { default: command } = await import('../../../../packages/cli/src/commands/card/show.command.js');

type ShowOpts = { json?: boolean };
const run = (ctx: unknown, cardId: string, opts: ShowOpts = {}) => (command.run as unknown as Handler<ShowOpts>)(opts, ctx, [cardId]);

const detail = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: '0001',
    title: 'do the thing',
    stage: 'backlog',
    dependsOn: [],
    needsHuman: false,
    body: '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n',
    sections: { 'Files in scope': '- src/a.ts' },
    ...overrides,
});

describe('wilson card show', () => {
    it('fetches the card and its recent events, and prints the plain-text view', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0001');
        expect(methodOf(fetchMock.mock.calls[0]!)).toBe('GET');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0001/events');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('limit=20');

        expect(logger.info).toHaveBeenCalledWith('0001  do the thing');
        expect(logger.info).toHaveBeenCalledWith('stage:    backlog');
        expect(logger.info).toHaveBeenCalledWith('branch:   —');
        expect(logger.info).toHaveBeenCalledWith('\nfiles in scope (1):');
        expect(logger.info).toHaveBeenCalledWith('  src/a.ts');
    });

    it('shows the branch, the blocked dependencies, and the flag reason when the card carries them', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(detail({ branch: 'card/0001', dependsOn: ['0002'], needsHuman: true, needsHumanReason: 'stuck' })),
        );
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('branch:   card/0001');
        expect(logger.info).toHaveBeenCalledWith('blocked:  0002');
        expect(logger.info).toHaveBeenCalledWith('needs human: stuck');
    });

    it('lists recent events with their type and stage', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(
            jsonResponse([{ id: 'e1', type: 'transition.written', stage: 'backlog', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' }]),
        );
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('\nrecent events:');
        expect(logger.info).toHaveBeenCalledWith('  2026-01-01T00:00:00.000Z  transition.written (backlog)');
    });

    it('renders a daemon.stale event\'s payload instead of the bare type name', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                {
                    id: 'e1',
                    type: 'daemon.stale',
                    stage: 'implementing',
                    payload: { daemonCommit: 'aaa1111', baseCommit: 'bbb2222', behindBy: 3 },
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
            ]),
        );
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith(
            '  2026-01-01T00:00:00.000Z  daemon.stale (implementing)  — daemon 3 commit(s) behind (running aaa1111, base bbb2222)',
        );
    });

    it('falls back to the bare type line for a daemon.stale event whose payload is missing behindBy', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(
            jsonResponse([
                { id: 'e1', type: 'daemon.stale', stage: 'implementing', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' },
            ]),
        );
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('  2026-01-01T00:00:00.000Z  daemon.stale (implementing)');
        const messages = logger.info.mock.calls.map((c: unknown[]) => c[0]);
        expect(messages.some((m: string) => m.includes('commit(s) behind'))).toBe(false);
    });

    it('prints a single JSON object with --json, dropping retries/planVersionId (no longer on the wire contract)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ branch: 'card/0001' })));
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001', { json: true });

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledTimes(1);
        const [printed] = logger.info.mock.calls[0] as [string];
        expect(JSON.parse(printed)).toEqual({
            id: '0001',
            title: 'do the thing',
            stage: 'backlog',
            branch: 'card/0001',
            dependsOn: [],
            filesInScope: ['src/a.ts'],
            secondsInStage: null,
            needsHuman: false,
            needsHumanReason: null,
        });
    });

    it('prints the API-supplied reason and exits 1 for a card that does not exist, rather than an HTTP status line', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(404, 'card 9999 not found'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '9999');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('card 9999 not found');
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
    });
});
