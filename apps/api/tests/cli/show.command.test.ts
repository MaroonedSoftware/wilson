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
    // Card 0166: the wire keys sections by slug (`sectionKey`, board.service.ts), not by the literal
    // heading — `filesInScope` (board-view.ts) reads `sections['files-in-scope']`.
    sections: { 'files-in-scope': '- src/a.ts' },
    ...overrides,
});

const card = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: '0001',
    title: 'x',
    stage: 'implementing',
    dependsOn: [],
    needsHuman: false,
    ...overrides,
});

// A fresh `Response` per call — its body can only be read once, and each test's `fetchMock` queue
// needs its own. Mirrors `list.command.test.ts`'s `columns()`.
const columns = () => jsonResponse({ stages: ['planning', 'implementing', 'testing'], nonStages: ['parking-lot', 'merged', 'poisoned', 'dropped'] });

/**
 * Card 0263: `run()` always fetches `GET .../usage` right after the card's recent events, whether
 * or not the card has any dependencies to check — so every test below that runs the command to
 * completion needs one more queued response than it did before this card. Defaults to no usage
 * recorded, which `printUsage` renders as nothing at all, keeping every test that isn't specifically
 * about usage output unaffected by it.
 */
const noUsage = () => jsonResponse({ total: { attempts: 0, inputTokens: 0, outputTokens: 0 }, stages: [] });

describe('wilson card show', () => {
    it('fetches the card and its recent events, and prints the plain-text view', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        fetchMock.mockResolvedValueOnce(noUsage());
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

    it('shows a split origin, its pieces, and how many have merged', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                detail({
                    splitFrom: '0100',
                    pieces: [
                        { id: '0002', title: 'piece a', stage: 'merged' },
                        { id: '0003', title: 'piece b', stage: 'planning' },
                    ],
                }),
            ),
        );
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        fetchMock.mockResolvedValueOnce(noUsage());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('split from: 0100');
        expect(logger.info).toHaveBeenCalledWith('\npieces (1/2 merged):');
        expect(logger.info).toHaveBeenCalledWith('  0003  planning  piece b');
    });

    it('prints no split lines for a card that was never split', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ pieces: [] })));
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        fetchMock.mockResolvedValueOnce(noUsage());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        const lines = logger.info.mock.calls.map((call: unknown[]) => String(call[0]));
        expect(lines.some((line: string) => line.includes('split from') || line.includes('pieces ('))).toBe(false);
    });

    it('shows the branch, the unsatisfied dependency, and the flag reason when the card carries them', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(detail({ branch: 'card/0001', dependsOn: ['0002'], needsHuman: true, needsHumanReason: 'stuck' })),
        );
        fetchMock.mockResolvedValueOnce(jsonResponse([])); // events
        fetchMock.mockResolvedValueOnce(noUsage()); // usage
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0002', stage: 'implementing' })])); // listCards
        fetchMock.mockResolvedValueOnce(columns()); // listBoardColumns
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        // `Promise.all([api.board.listCards(), api.board.listBoardColumns()])` calls both array
        // elements synchronously in that order, so the mock queue reflects it: cards first, columns
        // second, after the card, its events and its usage.
        expect(urlOf(fetchMock.mock.calls[3]!)).toContain('/api/cards');
        expect(urlOf(fetchMock.mock.calls[3]!)).not.toContain('/api/cards/0001');
        expect(urlOf(fetchMock.mock.calls[4]!)).toContain('/api/stages');

        expect(logger.info).toHaveBeenCalledWith('branch:   card/0001');
        expect(logger.info).toHaveBeenCalledWith('blocked:  0002');
        expect(logger.info).toHaveBeenCalledWith('needs human: stuck');
    });

    it('names only the unmerged dependency when one dependency has merged and one has not — card 0154', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ dependsOn: ['0155', '0162'] })));
        fetchMock.mockResolvedValueOnce(jsonResponse([])); // events
        fetchMock.mockResolvedValueOnce(noUsage()); // usage
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0155', stage: 'merged' }), card({ id: '0162', stage: 'implementing' })]));
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        // Card 0154 displayed `blocked: 0155, 0162` even though 0155 was long merged; `wilson card
        // next` (which goes through `unsatisfiedDependencies`) correctly reported only 0162.
        expect(logger.info).toHaveBeenCalledWith('blocked:  0162');
        const messages = logger.info.mock.calls.map((c: unknown[]) => c[0]);
        expect(messages.some(m => typeof m === 'string' && m.includes('0155'))).toBe(false);
    });

    it('shows no blocked: line at all when every dependency has merged', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ dependsOn: ['0002'] })));
        fetchMock.mockResolvedValueOnce(jsonResponse([])); // events
        fetchMock.mockResolvedValueOnce(noUsage()); // usage
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0002', stage: 'merged' })]));
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        const messages = logger.info.mock.calls.map((c: unknown[]) => c[0]);
        expect(messages.some(m => typeof m === 'string' && m.startsWith('blocked:'))).toBe(false);
    });

    it('shows a dropped or poisoned dependency as one that will never clear, distinct from one still waiting', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ dependsOn: ['0002', '0003'] })));
        fetchMock.mockResolvedValueOnce(jsonResponse([])); // events
        fetchMock.mockResolvedValueOnce(noUsage()); // usage
        fetchMock.mockResolvedValueOnce(jsonResponse([card({ id: '0002', stage: 'dropped' }), card({ id: '0003', stage: 'implementing' })]));
        fetchMock.mockResolvedValueOnce(columns());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('blocked:  0002 (dropped — will never merge), 0003');
    });

    it('issues no extra request when the card names no dependencies', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ dependsOn: [] })));
        fetchMock.mockResolvedValueOnce(jsonResponse([])); // events
        fetchMock.mockResolvedValueOnce(noUsage()); // usage
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        // Card 0263: the card, its events and its usage — three requests now, not two, since
        // `run()` always fetches usage whether or not there is a dependency to check.
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const messages = logger.info.mock.calls.map((c: unknown[]) => c[0]);
        expect(messages.some(m => typeof m === 'string' && m.startsWith('blocked:'))).toBe(false);
    });

    it('reports zero files in scope, without throwing, when the plan genuinely has no Files in scope section', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ sections: { goal: 'do it' } })));
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        fetchMock.mockResolvedValueOnce(noUsage());
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0001');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith('\nfiles in scope (0):');
    });

    it('lists recent events with their type and stage', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(
            jsonResponse([{ id: 'e1', type: 'transition.written', stage: 'backlog', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' }]),
        );
        fetchMock.mockResolvedValueOnce(noUsage());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('\nrecent events:');
        expect(logger.info).toHaveBeenCalledWith('  2026-01-01T00:00:00.000Z  transition.written (backlog)');
    });

    it("renders a daemon.stale event's payload instead of the bare type name", async () => {
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
        fetchMock.mockResolvedValueOnce(noUsage());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith(
            '  2026-01-01T00:00:00.000Z  daemon.stale (implementing)  — daemon 3 commit(s) behind (running aaa1111, base bbb2222)',
        );
    });

    it('falls back to the bare type line for a daemon.stale event whose payload is missing behindBy', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(
            jsonResponse([{ id: 'e1', type: 'daemon.stale', stage: 'implementing', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' }]),
        );
        fetchMock.mockResolvedValueOnce(noUsage());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(logger.info).toHaveBeenCalledWith('  2026-01-01T00:00:00.000Z  daemon.stale (implementing)');
        const messages = logger.info.mock.calls.map((c: unknown[]) => c[0] as string);
        expect(messages.some(m => m.includes('commit(s) behind'))).toBe(false);
    });

    it('prints a single JSON object with --json, dropping retries/planVersionId (no longer on the wire contract)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail({ branch: 'card/0001' })));
        fetchMock.mockResolvedValueOnce(jsonResponse([]));
        fetchMock.mockResolvedValueOnce(noUsage());
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
            splitFrom: null,
            pieces: [],
        });
    });

    // Card 0263, AC6: `wilson card show` prints the same per-stage and total token counts the
    // card page's Usage table renders.
    it('prints a usage line per stage plus a total, from GET .../usage', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(jsonResponse([])); // events
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                total: { attempts: 3, inputTokens: 300, outputTokens: 50 },
                stages: [
                    { stage: 'implementing', attempts: 2, inputTokens: 200, outputTokens: 40 },
                    { stage: 'testing', attempts: 1, inputTokens: 100, outputTokens: 10 },
                ],
            }),
        );
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        expect(urlOf(fetchMock.mock.calls[2]!)).toContain('/api/cards/0001/usage');
        expect(logger.info).toHaveBeenCalledWith('\nusage:');
        expect(logger.info).toHaveBeenCalledWith('  implementing: 2 attempt(s), 200 in / 40 out');
        expect(logger.info).toHaveBeenCalledWith('  testing: 1 attempt(s), 100 in / 10 out');
        expect(logger.info).toHaveBeenCalledWith('  total: 3 attempt(s), 300 in / 50 out');
    });

    it('prints no usage section at all for a card with no usage recorded yet', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(detail()));
        fetchMock.mockResolvedValueOnce(jsonResponse([])); // events
        fetchMock.mockResolvedValueOnce(noUsage());
        const { ctx, logger } = buildCtx();

        await run(ctx, '0001');

        const messages = logger.info.mock.calls.map((c: unknown[]) => c[0]);
        expect(messages.some(m => typeof m === 'string' && m.includes('usage:'))).toBe(false);
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
