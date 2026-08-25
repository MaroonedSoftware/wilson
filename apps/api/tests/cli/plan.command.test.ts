import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardConfig, BoardRepository, PLAN_SECTIONS, WorktreeManager, type Card } from '@wilson/api/cli-bootstrap';

// `plan.command.ts` wraps its handler in johnny5's `requireContainer`, exactly like `run.command.ts`
// does. Stubbed out for the same reason `run.command.test.ts` stubs it: this test is about the plan
// command's own guard order, worktree lifecycle and draft validation, not johnny5's DI plumbing.
vi.mock('@maroonedsoftware/johnny5/serverkit', () => ({
    requireContainer: (handler: unknown) => handler,
}));

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

const { gitMock } = vi.hoisted(() => ({ gitMock: vi.fn() }));
// The command deletes the throwaway plan branch with a raw `git` call rather than a `WorktreeManager`
// method (that method would live outside this card's files in scope). Only `git` is replaced here —
// everything else `@wilson/api/cli-bootstrap` exports stays real, the same way the johnny5 mock above
// keeps everything but `prompts.confirm`.
vi.mock('@wilson/api/cli-bootstrap', async importOriginal => {
    const actual = await importOriginal<typeof import('@wilson/api/cli-bootstrap')>();
    return { ...actual, git: gitMock };
});

// Imported after the mocks above are declared; vitest hoists `vi.mock` calls above imports, so by
// the time this module (and transitively `plan.command.ts`) loads, both stubs are already in place.
const { default: command } = await import('../../../../packages/cli/src/commands/card/plan.command.js');

type Handler = (opts: unknown, ctx: unknown, args: unknown[]) => Promise<number | void>;
const run = command.run as unknown as Handler;

type PlanSection = (typeof PLAN_SECTIONS)[number];

const section = (name: string, body: string): string => `## ${name}\n\n${body}\n`;

/** A complete, dispatchable plan body: every `PLAN_SECTIONS` heading present and non-empty. */
const completeDraft = (overrides: Partial<Record<PlanSection, string>> = {}): string => {
    const defaults: Record<PlanSection, string> = {
        Goal: 'Do the thing.',
        Constraints: 'Be careful.',
        'Files in scope': '- `src/thing.ts`',
        Tasks: '1. Do it.',
        'Acceptance criteria': 'It works.',
        'Out of scope': 'Nothing else.',
    };
    return PLAN_SECTIONS.map(s => section(s, overrides[s] ?? defaults[s])).join('\n');
};

const buildCard = (overrides: Partial<Card['frontmatter']> = {}, body = completeDraft()): Card => ({
    frontmatter: { id: '0099', title: 'Plan a thing', stage: 'planning', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body,
});

describe('card plan command', () => {
    let base: string;
    let boardRoot: string;
    let runRoot: string;
    let worktreePath: string;
    let config: BoardConfig;
    let worktrees: {
        branchName: ReturnType<typeof vi.fn>;
        hasWork: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        reclaim: ReturnType<typeof vi.fn>;
    };
    let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

    const draftPathFor = (cardId: string) => join(runRoot, 'cards', cardId, 'draft.md');

    const buildCtx = (board: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }) => ({
        container: {
            get: (token: unknown) => {
                if (token === BoardConfig) return config;
                if (token === BoardRepository) return board;
                if (token === WorktreeManager) return worktrees;
                throw new Error(`buildCtx: unexpected token ${String(token)}`);
            },
        },
        logger,
    });

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'plan-cmd-'));
        boardRoot = join(base, 'board');
        runRoot = join(base, 'run');
        worktreePath = join(base, 'worktree');
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        await mkdir(worktreePath, { recursive: true });
        await mkdir(runRoot, { recursive: true });
        await writeFile(
            join(boardRoot, 'config', 'stages.yaml'),
            [
                'stages:',
                '  - name: planning',
                '    mode: manual',
                '    model: claude-test-model',
                '    instructions: Read the repo and write a complete plan to the draft file.',
                '    onPass: parking-lot',
                '    onFail: planning',
                '',
            ].join('\n'),
            'utf8',
        );

        config = { project: 'wilson', boardRoot, codeRoot: join(base, 'code'), worktreeRoot: join(base, 'worktrees'), runRoot } as unknown as BoardConfig;

        worktrees = {
            branchName: vi.fn((id: string, title: string) => `card/${id}-${title.toLowerCase().replace(/\s+/g, '-')}`),
            hasWork: vi.fn().mockResolvedValue(false),
            create: vi.fn().mockResolvedValue({ path: worktreePath, branch: 'wilson-plan/0099', baseSha: 'deadbeef' }),
            reclaim: vi.fn().mockResolvedValue(undefined),
        };
        logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

        runInteractiveMock.mockReset();
        confirmMock.mockReset();
        confirmMock.mockResolvedValue(true);
        gitMock.mockReset();
        gitMock.mockResolvedValue({ stdout: '', stderr: '' });
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true });
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.WILSON_PLAN_TEST_MARKER;
    });

    it('refuses when the card is not in the planning stage, before touching any worktree', async () => {
        const card = buildCard({ stage: 'implementing' });
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('implementing'));
        expect(worktrees.create).not.toHaveBeenCalled();
        expect(runInteractiveMock).not.toHaveBeenCalled();
        expect(board.write).not.toHaveBeenCalled();
    });

    it('refuses when the card branch already has work, naming the branch', async () => {
        const card = buildCard();
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        worktrees.hasWork.mockResolvedValue(true);

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(1);
        const branch = worktrees.branchName.mock.results[0]!.value as string;
        expect(worktrees.hasWork).toHaveBeenCalledWith(branch);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(branch));
        expect(worktrees.create).not.toHaveBeenCalled();
        expect(board.write).not.toHaveBeenCalled();
    });

    it('writes exactly one new version, cleans up the throwaway worktree, and scrubs the environment on a complete approved draft', async () => {
        const card = buildCard({}, completeDraft({ Goal: 'Old goal.' }));
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn().mockResolvedValue('v2') };
        const draft = completeDraft({ Goal: 'New goal.' });
        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPathFor('0099'), draft, 'utf8');
        });
        confirmMock.mockResolvedValue(true);
        process.env.ANTHROPIC_API_KEY = 'secret-key';
        process.env.WILSON_PLAN_TEST_MARKER = 'still-here';

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(0);
        expect(worktrees.create).toHaveBeenCalledWith('plan-0099', 'wilson-plan/0099');
        expect(worktrees.reclaim).toHaveBeenCalledWith('plan-0099');
        expect(gitMock).toHaveBeenCalledWith(config.codeRoot, ['branch', '-D', 'wilson-plan/0099']);

        expect(board.write).toHaveBeenCalledTimes(1);
        const [id, message, mutate] = board.write.mock.calls[0]!;
        expect(id).toBe('0099');
        expect(String(message)).toContain('0099');
        const mutated = await (mutate as (c: Card) => Card | Promise<Card>)(card);
        expect(mutated.body).toBe(draft);

        expect(runInteractiveMock).toHaveBeenCalledTimes(1);
        const [bin, args, options] = runInteractiveMock.mock.calls[0]! as [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv }];
        expect(bin).toBe('claude');
        expect(args[args.indexOf('--model') + 1]).toBe('claude-test-model');
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
        expect(args[args.indexOf('--add-dir') + 1]).toBe(join(runRoot, 'cards', '0099'));

        const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
        expect(settings.permissions.deny).toContain(`Edit(${worktreePath}/**)`);
        expect(settings.permissions.allow).toContain(`Edit(${draftPathFor('0099')})`);

        expect(options?.cwd).toBe(worktreePath);
        // The scrubbed environment: no visible API key (which would silently reroute `claude` to
        // per-token billing), but everything else the process had stays.
        expect(options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
        expect(options?.env?.WILSON_PLAN_TEST_MARKER).toBe('still-here');
    });

    it('declines the confirmation and writes nothing, but still tears down the worktree', async () => {
        const card = buildCard({}, completeDraft({ Goal: 'Old goal.' }));
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPathFor('0099'), completeDraft({ Goal: 'New goal.' }), 'utf8');
        });
        confirmMock.mockResolvedValue(false);

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('declined'));
        expect(board.write).not.toHaveBeenCalled();
        expect(worktrees.reclaim).toHaveBeenCalledWith('plan-0099');
        expect(gitMock).toHaveBeenCalledWith(config.codeRoot, ['branch', '-D', 'wilson-plan/0099']);
    });

    it('writes nothing and never prompts when the draft comes back byte-for-byte unchanged', async () => {
        const body = completeDraft();
        const card = buildCard({}, body);
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPathFor('0099'), body, 'utf8');
        });

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
        expect(board.write).not.toHaveBeenCalled();
        expect(confirmMock).not.toHaveBeenCalled();
        expect(worktrees.reclaim).toHaveBeenCalledWith('plan-0099');
        expect(gitMock).toHaveBeenCalledWith(config.codeRoot, ['branch', '-D', 'wilson-plan/0099']);
    });

    it('refuses an incomplete draft missing a whole section, naming it, and writes nothing', async () => {
        const card = buildCard({}, completeDraft());
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        const incomplete = PLAN_SECTIONS.filter(s => s !== 'Out of scope')
            .map(s => section(s, 'content'))
            .join('\n');
        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPathFor('0099'), incomplete, 'utf8');
        });

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Out of scope'));
        expect(board.write).not.toHaveBeenCalled();
        expect(confirmMock).not.toHaveBeenCalled();
        expect(worktrees.reclaim).toHaveBeenCalledWith('plan-0099');
        expect(gitMock).toHaveBeenCalledWith(config.codeRoot, ['branch', '-D', 'wilson-plan/0099']);
    });

    it('refuses a draft whose "Files in scope" section has no actual entry once comments are stripped', async () => {
        const card = buildCard({}, completeDraft());
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        // Non-empty text, so it clears the "is this section blank" check, but `filesInScope` strips
        // HTML-comment lines and is left with nothing — the second, more specific guard this exists
        // to catch (a plan that would otherwise die much later at `assertDispatchable`).
        const draft = completeDraft({ 'Files in scope': '<!-- filled in during implementation -->' });
        runInteractiveMock.mockImplementation(async () => {
            await writeFile(draftPathFor('0099'), draft, 'utf8');
        });

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('empty "Files in scope"'));
        expect(board.write).not.toHaveBeenCalled();
    });

    it('seeds the draft with the six-heading skeleton when the card body has no sections yet', async () => {
        const card = buildCard({}, 'Just some free-form notes, no headings at all.');
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn().mockResolvedValue('v2') };
        let seedSeenByAgent = '';
        runInteractiveMock.mockImplementation(async () => {
            seedSeenByAgent = await readFile(draftPathFor('0099'), 'utf8');
            await writeFile(draftPathFor('0099'), completeDraft(), 'utf8');
        });

        const result = await run({}, buildCtx(board), ['0099']);

        expect(result).toBe(0);
        const expectedSkeleton = PLAN_SECTIONS.map(s => `## ${s}\n`).join('\n');
        expect(seedSeenByAgent).toBe(expectedSkeleton);
    });

    it('seeds the draft with the card body verbatim when sections already exist', async () => {
        const body = completeDraft({ Goal: 'A goal that already exists.' });
        const card = buildCard({}, body);
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        let seedSeenByAgent = '';
        runInteractiveMock.mockImplementation(async () => {
            seedSeenByAgent = await readFile(draftPathFor('0099'), 'utf8');
            // Leave it unchanged so the run resolves quickly.
        });

        await run({}, buildCtx(board), ['0099']);

        expect(seedSeenByAgent).toBe(body);
    });

    it('still tears down the throwaway worktree and branch when the interactive session itself fails', async () => {
        const card = buildCard();
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        runInteractiveMock.mockRejectedValue(new Error('claude exited unexpectedly'));

        await expect(run({}, buildCtx(board), ['0099'])).rejects.toThrow('claude exited unexpectedly');

        expect(worktrees.reclaim).toHaveBeenCalledWith('plan-0099');
        expect(gitMock).toHaveBeenCalledWith(config.codeRoot, ['branch', '-D', 'wilson-plan/0099']);
        expect(board.write).not.toHaveBeenCalled();
    });

    it('still reclaims the throwaway id and deletes its branch even when cutting the worktree itself fails', async () => {
        const card = buildCard();
        const board = { read: vi.fn().mockResolvedValue(card), write: vi.fn() };
        worktrees.create.mockRejectedValue(new Error('git worktree add failed'));

        await expect(run({}, buildCtx(board), ['0099'])).rejects.toThrow('git worktree add failed');

        expect(worktrees.reclaim).toHaveBeenCalledWith('plan-0099');
        expect(gitMock).toHaveBeenCalledWith(config.codeRoot, ['branch', '-D', 'wilson-plan/0099']);
        expect(runInteractiveMock).not.toHaveBeenCalled();
    });
});
