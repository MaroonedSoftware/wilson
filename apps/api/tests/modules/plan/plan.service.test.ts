import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { PlanService } from '#modules/plan/plan.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { PLAN_SECTIONS, type Card } from '#modules/board/card.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { DB } from '#modules/data/db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} } as unknown as Logger;
const fakeEvents = { append: vi.fn(async () => {}) } as unknown as EventLog;

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}, body = 'body text'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body,
});

/** A full six-heading plan body — the "complete draft" `save` accepts. */
const FULL_BODY = [
    '## Goal',
    'Ship the thing.',
    '',
    '## Constraints',
    'Keep it small.',
    '',
    '## Files in scope',
    '- src/thing.ts',
    '',
    '## Tasks',
    '1. Do it.',
    '',
    '## Acceptance criteria',
    '- It works.',
    '',
    '## Out of scope',
    'Nothing else.',
    '',
].join('\n');

/** Same six headings, but "Constraints" is left empty — the shape `save` must refuse. */
const INCOMPLETE_BODY = FULL_BODY.replace('Keep it small.\n\n', '');

/**
 * All six headings present and non-empty by `sectionsOf`'s own reading, but "Files in scope" holds
 * only a comment — `filesInScope` strips `<!--` lines, so this passes the heading check and still
 * has to be refused by the second, glob-specific check.
 */
const EMPTY_SCOPE_BODY = FULL_BODY.replace('- src/thing.ts', '<!-- none yet -->');

let db: Kysely<DB>;
let boardRoot: string;

beforeAll(async () => {
    db = testDb();

    const base = await mkdtemp(join(tmpdir(), 'plan-service-'));
    boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(
        join(boardRoot, 'config', 'stages.yaml'),
        [
            'stages:',
            '  - name: planning',
            '    mode: manual',
            '    model: claude-opus-planning',
            "    instructions: 'Write a plan for this card, covering the six standard headings.'",
            '    onPass: implementing',
            '    onFail: planning',
            '  - name: implementing',
            '    mode: agent',
            '    model: claude-opus',
            '    instructions: build it',
            '    onPass: testing',
            '    onFail: implementing',
            '  - name: testing',
            '    mode: agent',
            '    model: claude-opus',
            '    instructions: test it',
            '    onPass: merged',
            '    onFail: implementing',
            '',
        ].join('\n'),
        'utf8',
    );
});

afterAll(async () => {
    await db.destroy();
});

/**
 * A fresh code repo, worktree root, run root, board project and `PlanService` for one test.
 *
 * The code repo is real git (like `worktree.manager.test.ts`) because `PlanService.open`/`close`
 * exercise `WorktreeManager` for real — a session's whole point is a worktree and a branch that
 * genuinely exist, not a mock that says they would. Each test gets its own temp code repo and its
 * own Postgres project, so cutting `plan-<id>`/`wilson-plan/<id>` in one test can never collide with
 * another test reusing the same card id.
 */
const freshEnv = async () => {
    const base = await mkdtemp(join(tmpdir(), 'plan-service-env-'));
    const codeRoot = join(base, 'code');
    await mkdir(join(codeRoot, 'src'), { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
    await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
    await exec('git', ['add', '-A'], { cwd: codeRoot });
    await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

    const worktreeRoot = join(base, 'worktrees');
    const runRoot = join(base, 'run');
    const config = new StaticBoardConfig(uniqueProject(), boardRoot, codeRoot, worktreeRoot, runRoot);
    const board = new PostgresBoardRepository(config, db, fakeEvents);
    const worktrees = new WorktreeManager(config, silentLogger);
    const service = new PlanService(board, config, worktrees);

    return { config, board, worktrees, service, codeRoot, worktreeRoot, runRoot };
};

describe('PlanService', () => {
    describe('open', () => {
        it('returns a real worktree path, the planning stage\'s model and instructions, and seeds the draft with the card body when it has sections', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0001', { stage: 'planning', title: 'Port allocator' }, FULL_BODY), 'seed');

            const session = await service.open('0001');

            expect(session.sessionId).toBe('0001');
            expect(existsSync(session.worktreePath)).toBe(true);
            expect(session.model).toBe('claude-opus-planning');
            expect(session.instructions).toContain('Write a plan for this card');
            expect(session.instructions).toContain(session.draftPath);

            expect(existsSync(session.draftPath)).toBe(true);
            expect(await readFile(session.draftPath, 'utf8')).toBe(FULL_BODY);
        });

        it('seeds the six-heading skeleton when the card has no sections', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0002', { stage: 'planning', title: 'Blank card' }, 'just some notes, no headings'), 'seed');

            const session = await service.open('0002');

            const seed = await readFile(session.draftPath, 'utf8');
            for (const section of PLAN_SECTIONS) {
                expect(seed).toContain(`## ${section}`);
            }
            expect(seed).not.toContain('just some notes');
        });

        it('refuses a card outside "planning", and cuts nothing', async () => {
            const { board, service, worktreeRoot, runRoot } = await freshEnv();
            await board.create(card('0003', { stage: 'implementing', title: 'Not planning' }), 'seed');

            await expect(service.open('0003')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('not "planning"') },
            });

            expect(existsSync(join(worktreeRoot, 'plan-0003'))).toBe(false);
            expect(existsSync(join(runRoot, 'cards', '0003', 'draft.md'))).toBe(false);
        });

        it('refuses a card whose real branch already has work, and cuts nothing', async () => {
            const { board, service, worktrees, worktreeRoot, runRoot } = await freshEnv();
            const title = 'Has code already';
            await board.create(card('0004', { stage: 'planning', title }), 'seed');

            // Give the card's own branch real, committed work — the state `hasWork` must catch.
            const cardBranch = worktrees.branchName('0004', title);
            const cardWorktree = await worktrees.create('0004', cardBranch);
            await writeFile(join(cardWorktree.path, 'src', 'feature.ts'), 'export const f = 1;\n', 'utf8');
            await worktrees.commit(cardWorktree, 'implementing');

            await expect(service.open('0004')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(cardBranch) },
            });

            expect(existsSync(join(worktreeRoot, 'plan-0004'))).toBe(false);
            expect(existsSync(join(runRoot, 'cards', '0004', 'draft.md'))).toBe(false);
        });

        it('cuts a worktree path and branch that are never the card\'s own', async () => {
            const { board, service, worktrees, config } = await freshEnv();
            const title = 'Port allocator';
            await board.create(card('0005', { stage: 'planning', title }), 'seed');

            const session = await service.open('0005');

            const cardWorktreePath = join(config.worktreeRoot, '0005');
            expect(session.worktreePath).not.toBe(cardWorktreePath);

            const cardBranch = worktrees.branchName('0005', title);
            const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: session.worktreePath });
            expect(stdout.trim()).not.toBe(cardBranch);
        });

        it('404s for a card that does not exist', async () => {
            const { service } = await freshEnv();
            await expect(service.open('9999')).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    describe('save', () => {
        it('refuses an incomplete draft, naming the missing heading, and writes no version', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0006', { stage: 'planning' }, 'original body'), 'seed');

            await expect(service.save('0006', { body: INCOMPLETE_BODY })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('Constraints') },
            });

            const stored = await board.read('0006');
            expect(stored.body).toBe('original body');
            expect(await board.versions('0006', 10)).toHaveLength(1);
        });

        it('refuses an empty "Files in scope" even when every heading is present, and writes no version', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0007', { stage: 'planning' }, 'original body'), 'seed');

            await expect(service.save('0007', { body: EMPTY_SCOPE_BODY })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('Files in scope') },
            });

            const stored = await board.read('0007');
            expect(stored.body).toBe('original body');
            expect(await board.versions('0007', 10)).toHaveLength(1);
        });

        it('writes exactly one new version for a complete draft', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0008', { stage: 'planning' }, 'original body'), 'seed');

            const detail = await service.save('0008', { body: FULL_BODY });

            expect(detail.body).toBe(FULL_BODY);
            const stored = await board.read('0008');
            expect(stored.body).toBe(FULL_BODY);
            expect(await board.versions('0008', 10)).toHaveLength(2);
        });

        it('is a no-op for an unchanged body — writes no version', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0009', { stage: 'planning' }, FULL_BODY), 'seed');

            const detail = await service.save('0009', { body: FULL_BODY });

            expect(detail.body).toBe(FULL_BODY);
            expect(await board.versions('0009', 10)).toHaveLength(1);
        });
    });

    describe('close', () => {
        it('removes the worktree and deletes the branch', async () => {
            const { board, service, codeRoot } = await freshEnv();
            await board.create(card('0010', { stage: 'planning', title: 'Closeable' }), 'seed');
            const session = await service.open('0010');
            expect(existsSync(session.worktreePath)).toBe(true);

            await service.close('0010');

            expect(existsSync(session.worktreePath)).toBe(false);
            const { stdout } = await exec('git', ['branch', '--list', '*0010*'], { cwd: codeRoot });
            expect(stdout.trim()).toBe('');
        });

        it('is idempotent — closing twice is not an error', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0011', { stage: 'planning', title: 'Close twice' }), 'seed');
            await service.open('0011');

            await service.close('0011');
            await expect(service.close('0011')).resolves.toBeUndefined();
        });

        it('is safe to call for a session that was never opened', async () => {
            const { service } = await freshEnv();
            await expect(service.close('9999')).resolves.toBeUndefined();
        });
    });
});
