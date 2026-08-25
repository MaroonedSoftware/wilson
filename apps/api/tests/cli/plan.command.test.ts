import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCtx, connectionRefused, fetchMock, jsonResponse, methodOf, reasonResponse, urlOf, type Handler } from './sdk-fetch.helper.js';

// Card 0085 ports `plan.command.ts` off its own container (`@wilson/api/cli-bootstrap`,
// `requireContainer`, `WorktreeManager`) and onto the planning-session API
// (`api.board.openAPlanningSession`/`saveAPlanDraft`/`closeAPlanningSession`), the same `withApi` +
// stubbed-`fetch` shape every other card-0078-ported command already uses (see
// `move.command.test.ts`). Everything about a fresh worktree, `stages.yaml`, and draft validation now
// lives server-side in `PlanService` — this test is about what is left locally: spawning `claude`
// with what the session response returns, showing the diff, the confirmation gate, and closing the
// session on every exit path.
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
// Only `prompts.confirm` is replaced — an interactive clack prompt would otherwise block on the
// test's stdin. `PromptCancelledError` and `unwrap` stay real, so the command's own
// `unwrap(await prompts.confirm(...))` call runs exactly as it does in production against a plain
// boolean (`isCancel` on a boolean is always false, so `unwrap` just returns it).
vi.mock('@maroonedsoftware/johnny5', async importOriginal => {
    const actual = await importOriginal<typeof import('@maroonedsoftware/johnny5')>();
    return { ...actual, prompts: { ...actual.prompts, confirm: confirmMock } };
});

const { runInteractiveMock } = vi.hoisted(() => ({ runInteractiveMock: vi.fn() }));
// `plan.command.ts`'s only use of `editor.ts` is `runInteractive` — the stand-in for the `claude`
// binary it spawns. Mocking it puts the whole "interactive session" under test control: what it
// writes to the draft file, and what it is invoked with.
vi.mock('../../../../packages/cli/src/commands/card/editor.js', () => ({
    runInteractive: runInteractiveMock,
}));

// Imported after the mocks above are declared; vitest hoists `vi.mock` calls above imports, so by
// the time this module (and transitively `plan.command.ts`) loads, both stubs are already in place.
const { default: command } = await import('../../../../packages/cli/src/commands/card/plan.command.js');

const run = (ctx: unknown, cardId: string) => (command.run as unknown as Handler)({}, ctx, [cardId]);

const cardDetail = (overrides: Partial<{ title: string; body: string; stage: string }> = {}) => ({
    id: '0099',
    title: 'Plan a thing',
    stage: 'planning',
    dependsOn: [],
    needsHuman: false,
    body: 'old body',
    sections: {},
    ...overrides,
});

const planSession = (overrides: Partial<{ sessionId: string; worktreePath: string; draftPath: string; model: string; instructions: string }> = {}) => ({
    sessionId: '0099',
    worktreePath: '/tmp/does-not-matter',
    draftPath: '/tmp/does-not-matter/draft.md',
    model: 'claude-test-model',
    instructions: 'Write a complete plan.',
    ...overrides,
});

describe('wilson card plan', () => {
    let base: string;
    let worktreePath: string;
    let draftPath: string;

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'plan-cmd-'));
        worktreePath = join(base, 'worktree');
        draftPath = join(base, 'run', 'cards', '0099', 'draft.md');
        await mkdir(worktreePath, { recursive: true });
        await mkdir(join(base, 'run', 'cards', '0099'), { recursive: true });

        runInteractiveMock.mockReset();
        confirmMock.mockReset();
        confirmMock.mockResolvedValue(true);
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true });
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.WILSON_PLAN_TEST_MARKER;
    });

    it('opens a session, drives claude with what the session returned, and on approval saves exactly once and closes', async () => {
        const card = cardDetail({ body: 'old body' });
        const session = planSession({ worktreePath, draftPath, model: 'claude-test-model' });
        const newDraft = 'new body';

        fetchMock.mockResolvedValueOnce(jsonResponse(card)); // getCard
        fetchMock.mockResolvedValueOnce(jsonResponse(session)); // open
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...card, body: newDraft })); // save
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })); // close

        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPath, newDraft, 'utf8');
        });
        confirmMock.mockResolvedValue(true);
        process.env.ANTHROPIC_API_KEY = 'secret-key';
        process.env.WILSON_PLAN_TEST_MARKER = 'still-here';
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0099');

        expect(result).toBe(0);

        // getCard, open, save, close — in that order, against the planning-session endpoints.
        expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/cards/0099');
        expect(urlOf(fetchMock.mock.calls[1]!)).toContain('/api/cards/0099/plan/open');
        expect(methodOf(fetchMock.mock.calls[1]!)).toBe('POST');
        expect(urlOf(fetchMock.mock.calls[2]!)).toContain('/api/cards/0099/plan/save');
        expect(methodOf(fetchMock.mock.calls[2]!)).toBe('POST');
        expect(JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body)).toEqual({ body: newDraft });
        expect(urlOf(fetchMock.mock.calls[3]!)).toContain('/api/cards/0099/plan/close');
        expect(methodOf(fetchMock.mock.calls[3]!)).toBe('POST');
        expect(fetchMock).toHaveBeenCalledTimes(4);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('planned'));

        // claude is spawned against exactly what the session response carried, not anything computed
        // locally.
        expect(runInteractiveMock).toHaveBeenCalledTimes(1);
        const [bin, args, options] = runInteractiveMock.mock.calls[0]! as [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv }];
        expect(bin).toBe('claude');
        expect(args[args.indexOf('--model') + 1]).toBe('claude-test-model');
        expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(session.instructions);
        expect(args[args.indexOf('--add-dir') + 1]).toBe(join(base, 'run', 'cards', '0099'));
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
        expect(args).not.toContain('plan');

        const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
        expect(settings.permissions.deny).toContain(`Edit(${worktreePath}/**)`);
        expect(settings.permissions.allow).toContain(`Edit(${draftPath})`);

        expect(options?.cwd).toBe(worktreePath);
        // The scrubbed environment: no visible API key (which would silently reroute `claude` to
        // per-token billing), but everything else the process had stays.
        expect(options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
        expect(options?.env?.WILSON_PLAN_TEST_MARKER).toBe('still-here');
    });

    it('declines the confirmation, writes nothing, but still closes the session', async () => {
        const card = cardDetail({ body: 'old body' });
        const session = planSession({ worktreePath, draftPath });

        fetchMock.mockResolvedValueOnce(jsonResponse(card)); // getCard
        fetchMock.mockResolvedValueOnce(jsonResponse(session)); // open
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })); // close

        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPath, 'new body', 'utf8');
        });
        confirmMock.mockResolvedValue(false);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0099');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('declined'));
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(urlOf(fetchMock.mock.calls[2]!)).toContain('/api/cards/0099/plan/close');
    });

    it('writes nothing and never prompts when the draft comes back byte-for-byte unchanged, but still closes', async () => {
        const body = 'same body';
        const card = cardDetail({ body });
        const session = planSession({ worktreePath, draftPath });

        fetchMock.mockResolvedValueOnce(jsonResponse(card)); // getCard
        fetchMock.mockResolvedValueOnce(jsonResponse(session)); // open
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })); // close

        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPath, body, 'utf8');
        });
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0099');

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
        expect(confirmMock).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(urlOf(fetchMock.mock.calls[2]!)).toContain('/api/cards/0099/plan/close');
    });

    it('still closes the session when the interactive claude session itself throws, and reports the failure rather than a raw stack trace', async () => {
        const card = cardDetail();
        const session = planSession({ worktreePath, draftPath });

        fetchMock.mockResolvedValueOnce(jsonResponse(card)); // getCard
        fetchMock.mockResolvedValueOnce(jsonResponse(session)); // open
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })); // close

        runInteractiveMock.mockRejectedValue(new Error('claude exited unexpectedly'));
        const { ctx, logger } = buildCtx();

        // `withApi` catches every handler error at the boundary — including one thrown from inside
        // the `try`/`finally` around the session — so this resolves 1 rather than rejecting; what
        // matters here is that the `finally`'s close still ran before that catch reported it.
        const result = await run(ctx, '0099');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('claude exited unexpectedly');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(urlOf(fetchMock.mock.calls[2]!)).toContain('/api/cards/0099/plan/close');
        expect(methodOf(fetchMock.mock.calls[2]!)).toBe('POST');
    });

    it('never opens a session when reading the card itself fails, and prints the API-supplied reason', async () => {
        fetchMock.mockResolvedValueOnce(reasonResponse(404, '0099 does not exist'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0099');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0099 does not exist');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(runInteractiveMock).not.toHaveBeenCalled();
    });

    it('prints the API-supplied reason and exits 1, never spawning claude, when open refuses the card', async () => {
        const card = cardDetail({ stage: 'backlog' });
        fetchMock.mockResolvedValueOnce(jsonResponse(card)); // getCard
        fetchMock.mockResolvedValueOnce(reasonResponse(400, '0099 is in stage "backlog", not "planning"'));
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0099');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('0099 is in stage "backlog", not "planning"');
        expect(runInteractiveMock).not.toHaveBeenCalled();
        // No close call either — a refused `open` never cut a session to close.
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('names the refused connection instead of throwing when the API is not running', async () => {
        fetchMock.mockImplementationOnce(connectionRefused);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0099');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is it running?'));
        expect(runInteractiveMock).not.toHaveBeenCalled();
    });

    it('reads back the draft written by the interactive session rather than trusting anything cached locally', async () => {
        const card = cardDetail({ body: 'old body' });
        const session = planSession({ worktreePath, draftPath });
        const draft = 'this is what the operator actually wrote';

        fetchMock.mockResolvedValueOnce(jsonResponse(card));
        fetchMock.mockResolvedValueOnce(jsonResponse(session));
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...card, body: draft }));
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

        runInteractiveMock.mockImplementation(async () => {
            // Write directly to the path the session handed back, as the real `claude` binary would.
            await writeFile(draftPath, draft, 'utf8');
        });
        confirmMock.mockResolvedValue(true);
        const { ctx } = buildCtx();

        await run(ctx, '0099');

        expect(JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body)).toEqual({ body: draft });
        await expect(readFile(draftPath, 'utf8')).resolves.toBe(draft);
    });

    it('shows an added/removed diff of the old and new body before asking to confirm', async () => {
        const card = cardDetail({ title: 'Plan a thing', body: 'line one\nline two\n' });
        const session = planSession({ worktreePath, draftPath });

        fetchMock.mockResolvedValueOnce(jsonResponse(card));
        fetchMock.mockResolvedValueOnce(jsonResponse(session));
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...card, body: 'line one\nline three\n' }));
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPath, 'line one\nline three\n', 'utf8');
        });
        confirmMock.mockResolvedValue(true);
        const { ctx, logger } = buildCtx();

        await run(ctx, '0099');

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('0099: Plan a thing'));
        expect(logger.info).toHaveBeenCalledWith('- line two');
        expect(logger.info).toHaveBeenCalledWith('+ line three');
        // The diff is shown, and only then is the operator asked — never the other order.
        const diffCallIndex = logger.info.mock.calls.findIndex(c => c[0] === '- line two');
        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(diffCallIndex).toBeGreaterThanOrEqual(0);
    });

    it('scrubs ANTHROPIC_AUTH_TOKEN as well as ANTHROPIC_API_KEY from the spawned environment', async () => {
        const card = cardDetail({ body: 'same' });
        const session = planSession({ worktreePath, draftPath });

        fetchMock.mockResolvedValueOnce(jsonResponse(card));
        fetchMock.mockResolvedValueOnce(jsonResponse(session));
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPath, 'same', 'utf8');
        });
        process.env.ANTHROPIC_AUTH_TOKEN = 'secret-token';
        const { ctx } = buildCtx();

        try {
            await run(ctx, '0099');
            const [, , options] = runInteractiveMock.mock.calls[0]! as [string, string[], { env?: NodeJS.ProcessEnv }];
            expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        } finally {
            delete process.env.ANTHROPIC_AUTH_TOKEN;
        }
    });

    it('still closes the session and reports the reason, not raw HTTP status text, when save itself refuses the draft', async () => {
        const card = cardDetail({ body: 'old body' });
        const session = planSession({ worktreePath, draftPath });

        fetchMock.mockResolvedValueOnce(jsonResponse(card)); // getCard
        fetchMock.mockResolvedValueOnce(jsonResponse(session)); // open
        fetchMock.mockResolvedValueOnce(reasonResponse(400, 'draft is incomplete — empty section(s): Tasks')); // save refuses
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })); // close

        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPath, 'new body', 'utf8');
        });
        confirmMock.mockResolvedValue(true);
        const { ctx, logger } = buildCtx();

        const result = await run(ctx, '0099');

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith('draft is incomplete — empty section(s): Tasks');
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(urlOf(fetchMock.mock.calls[3]!)).toContain('/api/cards/0099/plan/close');
        expect(methodOf(fetchMock.mock.calls[3]!)).toBe('POST');
    });
});
