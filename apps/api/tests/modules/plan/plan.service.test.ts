import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { PlanService } from '#modules/plan/plan.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { PLAN_SECTIONS, type Card } from '#modules/board/card.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { DB } from '#modules/data/db.js';
import { planFeed } from '#modules/plan/plan.session.feed.js';
import { planSessions } from '#modules/plan/plan.session.registry.js';
import { PlanTurnRepository } from '#modules/plan/plan.turn.repository.js';
import { CLAUDE_CONFIG_DIR } from '#modules/settings/claude.config.dir.setting.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} } as unknown as Logger;
const fakeEvents = { append: vi.fn(async () => {}) } as unknown as EventLog;

/**
 * Card 0133: `PlanService.turn` drives the registry's live session, which constructs a real
 * `PlanSessionAgent` — a real `@anthropic-ai/claude-agent-sdk` `query()` call. Replaced here with a
 * bare double, the same way `plan.session.registry.test.ts` replaces it for the registry's own
 * tests, so `turn`'s own job — appending turns, composing the first-turn prompt, publishing deltas,
 * stripping `engineSessionId` before it reaches a caller — is exercised without spinning up a real
 * engine. The double echoes its prompt back one word at a time, so a turn's stored `content` is a
 * direct, checkable record of exactly what `PlanService` sent it.
 */
const { PlanSessionAgentMock, sessionAgentCalls, instances, disposeSpy } = vi.hoisted(() => {
    const sessionAgentCalls: Array<{ worktreeRoot: string; model: string; resume?: string; configDir?: string }> = [];
    // Every mock instance ever constructed, in construction order — the counter behind `sessionId`
    // is shared across every test in this file (it lives in this one hoisted closure), so a test
    // must read the id an instance was actually given back off this array rather than assume which
    // number it landed on.
    const instances: InstanceType<typeof PlanSessionAgentMock>[] = [];
    const disposeSpy = vi.fn();
    let counter = 0;
    class PlanSessionAgentMock {
        readonly options: { worktreeRoot: string; model: string; resume?: string; configDir?: string };
        sessionId: string | undefined;
        constructor(options: { worktreeRoot: string; model: string; resume?: string; configDir?: string }) {
            this.options = options;
            sessionAgentCalls.push(options);
            counter += 1;
            this.sessionId = `engine-session-${counter}`;
            instances.push(this);
        }
        async *turn(text: string): AsyncGenerator<string> {
            const words = text.split(' ');
            for (const [index, word] of words.entries()) {
                yield index === 0 ? word : ` ${word}`;
            }
        }
        dispose(): void {
            disposeSpy(this);
        }
    }
    return { PlanSessionAgentMock, sessionAgentCalls, instances, disposeSpy };
});

vi.mock('#modules/agent/plan.session.agent.js', () => ({ PlanSessionAgent: PlanSessionAgentMock }));

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

/** The stage config every `freshEnv` reads — a store, not a `stages.yaml` under `boardRoot`. */
const stageConfigs = new StaticStageConfigStore(
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
);

beforeAll(async () => {
    db = testDb();

    const base = await mkdtemp(join(tmpdir(), 'plan-service-'));
    boardRoot = join(base, 'board');
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
    const service = new PlanService(board, config, worktrees, db, stageConfigs);

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

        it('seeds the card\'s own prose plus the full six-heading skeleton when the card has no sections, discarding nothing', async () => {
            const { board, service } = await freshEnv();
            const body = '## Note\n\njust some notes, no headings\n';
            await board.create(card('0002', { stage: 'planning', title: 'Blank card' }, body), 'seed');

            const session = await service.open('0002');

            const seed = await readFile(session.draftPath, 'utf8');
            // Card 0124: the old behaviour discarded a note-shaped card's prose for a blank skeleton
            // the moment it had zero of the six plan headings. The prose — and the card's own
            // non-plan heading — must now survive into the draft, not just the skeleton.
            expect(seed).toContain('## Note');
            expect(seed).toContain('just some notes, no headings');
            for (const section of PLAN_SECTIONS) {
                expect(seed).toContain(`## ${section}`);
            }
            // The appended headings are the ones to fill in, not pre-filled with anything.
            for (const section of PLAN_SECTIONS) {
                expect(seed).toMatch(new RegExp(`## ${section}\\n(\\n## |$)`));
            }
        });

        it('seeds the card\'s own headings where they are and appends only the ones it lacks, in PLAN_SECTIONS order, when it has some but not all', async () => {
            const { board, service } = await freshEnv();
            const body = ['## Out of scope', 'Nothing outside the API.', '', '## Goal', 'Ship the seed fix.', ''].join('\n');
            await board.create(card('0013', { stage: 'planning', title: 'Partial card' }, body), 'seed');

            const session = await service.open('0013');

            const seed = await readFile(session.draftPath, 'utf8');
            // The two headings the card already had keep their own order and wording — "Out of
            // scope" before "Goal", exactly as written, not moved to canonical position.
            const outOfScopeIndex = seed.indexOf('## Out of scope');
            const goalIndex = seed.indexOf('## Goal');
            expect(outOfScopeIndex).toBeGreaterThanOrEqual(0);
            expect(goalIndex).toBeGreaterThan(outOfScopeIndex);
            expect(seed).toContain('Nothing outside the API.');
            expect(seed).toContain('Ship the seed fix.');

            // Only the four missing headings were appended, each after the card's own content, in
            // PLAN_SECTIONS order among themselves.
            const missing = PLAN_SECTIONS.filter(s => s !== 'Out of scope' && s !== 'Goal');
            let cursor = goalIndex;
            for (const section of missing) {
                const idx = seed.indexOf(`## ${section}`, cursor);
                expect(idx).toBeGreaterThan(cursor);
                cursor = idx;
            }
        });

        it('leaves a card with all six headings byte-identical, and says so in the instructions, even though completeSections now runs on every card', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0014', { stage: 'planning', title: 'Full card' }, FULL_BODY), 'seed');

            const session = await service.open('0014');

            expect(await readFile(session.draftPath, 'utf8')).toBe(FULL_BODY);
            expect(session.instructions).toContain("this card's existing body");
            expect(session.instructions).not.toContain('empty six-heading skeleton');
        });

        it('tells the agent the draft holds the card\'s own notes plus the headings it was missing, not that it is an empty skeleton, when sections are incomplete', async () => {
            const { board, service } = await freshEnv();
            const body = '## Note\n\ncaptured mid-review\n';
            await board.create(card('0015', { stage: 'planning', title: 'Note card' }, body), 'seed');

            const session = await service.open('0015');

            expect(session.instructions).toContain("the card's own notes above");
            expect(session.instructions).toContain('plan-contract headings it was missing');
            expect(session.instructions).not.toContain('empty six-heading skeleton');
            expect(session.instructions).not.toBe("this card's existing body");
        });

        it('refuses a card outside "planning", and cuts nothing', async () => {
            const { board, service, worktreeRoot, runRoot } = await freshEnv();
            await board.create(card('0003', { stage: 'implementing', title: 'Not planning' }), 'seed');

            await expect(service.open('0003')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('can only be talked through in "planning" or "parking-lot"') },
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

        /**
         * Card 0095: the guard used to recompute the branch from the card's *current* title on every
         * call, so a card renamed after its branch was recorded (and work committed to it) would be
         * checked against a branch that never existed — `hasWork` on that title-derived name would
         * read false, and a card with real code on it would sail through as if it were untouched.
         */
        it('refuses a card whose recorded branch already has work, even after the card has since been renamed', async () => {
            const { board, service, worktrees, worktreeRoot, runRoot } = await freshEnv();
            const originalTitle = 'Has code already';
            const recordedBranch = worktrees.branchName('0012', originalTitle);

            // Give the *recorded* branch — not whatever the current title would derive — real,
            // committed work.
            const cardWorktree = await worktrees.create('0012', recordedBranch);
            await writeFile(join(cardWorktree.path, 'src', 'feature.ts'), 'export const f = 1;\n', 'utf8');
            await worktrees.commit(cardWorktree, 'implementing');

            // The card on the board now carries a different title and the branch recorded before the
            // rename. `branchName('0012', 'A brand new title')` would derive yet a third name, with no
            // work on it at all — which is exactly what the guard must not be fooled by.
            await board.create(card('0012', { stage: 'planning', title: 'A brand new title', branch: recordedBranch }), 'seed');
            expect(worktrees.branchName('0012', 'A brand new title')).not.toBe(recordedBranch);

            await expect(service.open('0012')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(recordedBranch) },
            });

            expect(existsSync(join(worktreeRoot, 'plan-0012'))).toBe(false);
            expect(existsSync(join(runRoot, 'cards', '0012', 'draft.md'))).toBe(false);
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

        /**
         * Card 0159: `assertPlannable` now accepts `parking-lot` alongside `planning` — a parked
         * card gets exactly the same cut worktree and seeded draft `open` has always produced for a
         * planning card, not a new or different shape for the new stage.
         */
        it('accepts a card in "parking-lot", cutting the same worktree and seed "planning" gets', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0040', { stage: 'parking-lot', title: 'Parked thought' }, FULL_BODY), 'seed');

            const session = await service.open('0040');

            expect(session.sessionId).toBe('0040');
            expect(existsSync(session.worktreePath)).toBe(true);
            expect(await readFile(session.draftPath, 'utf8')).toBe(FULL_BODY);
        });

        /**
         * Card 0159's Constraints: the branch guard stays untouched — it must still fire for
         * `parking-lot` exactly as it does for `planning`. Before this card a parked card's `open`
         * was refused for its stage alone, with a reason that never mentions the branch; this proves
         * the *branch* guard is the one now doing the refusing.
         */
        it('still refuses a "parking-lot" card whose real branch already has work, and cuts nothing', async () => {
            const { board, service, worktrees, worktreeRoot, runRoot } = await freshEnv();
            const title = 'Has code already';
            await board.create(card('0041', { stage: 'parking-lot', title }), 'seed');

            const cardBranch = worktrees.branchName('0041', title);
            const cardWorktree = await worktrees.create('0041', cardBranch);
            await writeFile(join(cardWorktree.path, 'src', 'feature.ts'), 'export const f = 1;\n', 'utf8');
            await worktrees.commit(cardWorktree, 'implementing');

            await expect(service.open('0041')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(cardBranch) },
            });

            expect(existsSync(join(worktreeRoot, 'plan-0041'))).toBe(false);
            expect(existsSync(join(runRoot, 'cards', '0041', 'draft.md'))).toBe(false);
        });

        /**
         * Card 0159's Constraints: "and nothing else" — relaxing the check to `planning` or
         * `parking-lot` must not have loosened it to any manual stage. Every other stage the queue
         * holds still gets refused, with the same sentence `open` has always given it.
         */
        it.each(['backlog', 'testing', 'review', 'ready'])('still refuses a card in "%s", and cuts nothing', async stage => {
            const { board, service, worktreeRoot, runRoot } = await freshEnv();
            const id = randomUUID();
            await board.create(card(id, { stage }), 'seed');

            await expect(service.open(id)).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('can only be talked through in "planning" or "parking-lot"') },
            });

            expect(existsSync(join(worktreeRoot, `plan-${id}`))).toBe(false);
            expect(existsSync(join(runRoot, 'cards', id, 'draft.md'))).toBe(false);
        });
    });

    describe('draft', () => {
        it('returns the exact bytes on disk, including a draft the agent has partly written mid-session', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0020', { stage: 'planning', title: 'Draft read' }, FULL_BODY), 'seed');
            const session = await service.open('0020');

            // Simulate the agent rewriting the draft after `open` seeded it — `draft` must reflect
            // whatever is on disk right now, not the seed `open` returned.
            await writeFile(session.draftPath, 'partial rewrite by the agent, mid-turn\n', 'utf8');

            await expect(service.draft('0020')).resolves.toEqual({ body: 'partial rewrite by the agent, mid-turn\n' });
        });

        it('returns the seed `open` wrote, before anything else has touched it', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0021', { stage: 'planning', title: 'Seed draft' }, FULL_BODY), 'seed');
            await service.open('0021');

            await expect(service.draft('0021')).resolves.toEqual({ body: FULL_BODY });
        });

        it('returns an empty body, not a 404, for a card in "planning" that has never had a session open', async () => {
            const { board, service, runRoot } = await freshEnv();
            await board.create(card('0022', { stage: 'planning', title: 'Never opened' }), 'seed');

            expect(existsSync(join(runRoot, 'cards', '0022', 'draft.md'))).toBe(false);
            await expect(service.draft('0022')).resolves.toEqual({ body: '' });
        });

        it('404s for a card that does not exist', async () => {
            const { service } = await freshEnv();
            await expect(service.draft('9999')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('creates no session, cuts no worktree, writes no card version, and appends no event', async () => {
            const { board, service, worktreeRoot } = await freshEnv();
            await board.create(card('0023', { stage: 'planning', title: 'Read only' }), 'seed');
            const eventsBefore = (fakeEvents.append as ReturnType<typeof vi.fn>).mock.calls.length;

            await service.draft('0023');

            expect(existsSync(join(worktreeRoot, 'plan-0023'))).toBe(false);
            expect(await board.versions('0023', 10)).toHaveLength(1);
            expect(fakeEvents.append).toHaveBeenCalledTimes(eventsBefore);
        });

        it('does not disturb a session already open on the card — a later `save` still sees the live worktree', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0024', { stage: 'planning', title: 'Read during session' }, FULL_BODY), 'seed');
            const session = await service.open('0024');

            await service.draft('0024');

            expect(existsSync(session.worktreePath)).toBe(true);
            const detail = await service.save('0024', { body: FULL_BODY });
            expect(detail.body).toBe(FULL_BODY);
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

        /**
         * Card 0124: `open` now seeds a note-shaped card with its own prose plus the headings it was
         * missing, instead of a blank skeleton — `save`'s own validation must not have loosened to
         * match. The appended headings arrive empty; submitting the seed back unedited must still be
         * refused for exactly the reason an untouched skeleton always was.
         */
        it('refuses the seed `open` produces for a note-shaped card, unedited, the same as it always refused an empty skeleton', async () => {
            const { board, service } = await freshEnv();
            const body = '## Note\n\ncaptured mid-review, no plan headings yet\n';
            await board.create(card('0016', { stage: 'planning', title: 'Note card' }, body), 'seed');

            const session = await service.open('0016');
            const seed = await readFile(session.draftPath, 'utf8');

            await expect(service.save('0016', { body: seed })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('Goal') },
            });

            const stored = await board.read('0016');
            expect(stored.body).toBe(body);
            expect(await board.versions('0016', 10)).toHaveLength(1);
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

    describe('comments', () => {
        it('addComment stores an open comment and touches neither the card body nor writes a version', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0030', { stage: 'planning' }, FULL_BODY), 'seed');

            const comment = await service.addComment('0030', {
                quote: 'Ship the thing.',
                prefix: '## Goal\n',
                suffix: '\n\n## Constraints',
                text: 'say more here',
            });

            expect(comment.quote).toBe('Ship the thing.');
            expect(comment.prefix).toBe('## Goal\n');
            expect(comment.suffix).toBe('\n\n## Constraints');
            expect(comment.text).toBe('say more here');
            expect(comment.resolved).toBe(false);
            expect(comment.id).toBeDefined();

            const stored = await board.read('0030');
            expect(stored.body).toBe(FULL_BODY);
            expect(await board.versions('0030', 10)).toHaveLength(1);
        });

        it('comments lists both open and resolved comments, distinguishable, and resolveComment leaves the comment on record', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0031', { stage: 'planning' }, FULL_BODY), 'seed');

            const first = await service.addComment('0031', { quote: 'a', prefix: '', suffix: '', text: 'one' });
            await service.addComment('0031', { quote: 'b', prefix: '', suffix: '', text: 'two' });

            const resolved = await service.resolveComment('0031', first.id);
            expect(resolved.resolved).toBe(true);
            expect(resolved.id).toBe(first.id);

            const list = await service.comments('0031');
            expect(list).toHaveLength(2);
            expect(list.find(c => c.id === first.id)?.resolved).toBe(true);
            expect(list.find(c => c.id !== first.id)?.resolved).toBe(false);
        });

        it('resolveComment 404s for a comment id that does not exist', async () => {
            const { board, service } = await freshEnv();
            await board.create(card('0032', { stage: 'planning' }, FULL_BODY), 'seed');

            await expect(service.resolveComment('0032', '999999999')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('addComment and comments both 404 for a card that does not exist', async () => {
            const { service } = await freshEnv();

            await expect(service.addComment('9999', { quote: 'q', prefix: '', suffix: '', text: 't' })).rejects.toMatchObject({
                statusCode: 404,
            });
            await expect(service.comments('9999')).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    describe('turn', () => {
        afterEach(() => {
            sessionAgentCalls.length = 0;
            instances.length = 0;
            disposeSpy.mockClear();
        });

        it('prepends a card\'s open comments, quoted alongside their text, to the first turn\'s prompt — after the stage instructions, before the operator\'s own text', async () => {
            const { board, service } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');
                await service.addComment(id, { quote: 'Ship the thing.', prefix: '## Goal\n', suffix: '\n\n## Constraints', text: 'please clarify this' });

                const result = await service.turn(id, { text: 'hello there' });

                const instructionsIdx = result.content.indexOf('Write a plan for this card');
                const quoteIdx = result.content.indexOf('Ship the thing.');
                const commentIdx = result.content.indexOf('please clarify this');
                const textIdx = result.content.indexOf('hello there');

                expect(instructionsIdx).toBeGreaterThanOrEqual(0);
                expect(quoteIdx).toBeGreaterThan(instructionsIdx);
                expect(commentIdx).toBeGreaterThan(quoteIdx);
                expect(textIdx).toBeGreaterThan(commentIdx);
            } finally {
                planSessions.dispose(id);
            }
        });

        it('a turn taken while a card has no open comments builds a prompt byte-identical to what turn sent before comments existed', async () => {
            const { board, service } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');
                // `open`'s own `cutSession` is what `turn` calls internally for a first turn too
                // (harmlessly re-cut, per `cutSession`'s own doc) — calling it here just reads back
                // the exact instructions text this card's draft produces, with nothing hardcoded.
                const session = await service.open(id);

                const result = await service.turn(id, { text: 'hello there' });

                expect(result.content).toBe(`${session.instructions}\n\nhello there`);
            } finally {
                planSessions.dispose(id);
            }
        });

        it('a resolved comment does not reach a later turn\'s prompt', async () => {
            const { board, service } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');
                const comment = await service.addComment(id, { quote: 'Ship the thing.', prefix: '', suffix: '', text: 'address this' });
                await service.resolveComment(id, comment.id);

                const result = await service.turn(id, { text: 'hello there' });

                expect(result.content).not.toContain('address this');
            } finally {
                planSessions.dispose(id);
            }
        });

        it('stores the user turn exactly as typed, without the comments preamble the prompt to the engine carried', async () => {
            const { board, service, config } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');
                await service.addComment(id, { quote: 'Ship the thing.', prefix: '', suffix: '', text: 'address this' });

                await service.turn(id, { text: 'first message' });

                const repo = new PlanTurnRepository(config, db);
                const stored = await repo.since(id, 0);
                expect(stored[0]!.content).toBe('first message');
            } finally {
                planSessions.dispose(id);
            }
        });

        it('holds one conversation across two turns: the first prompt carries the planning stage\'s own instructions, the second carries only the raw text, and only one engine session is ever constructed', async () => {
            const { board, service } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning', title: 'Turn card' }, FULL_BODY), 'seed');

                const first = await service.turn(id, { text: 'hello there' });
                expect(first.content).toContain('Write a plan for this card');
                expect(first.content).toContain('hello there');

                // The second turn's reply demonstrates the model saw the first exchange: no
                // instructions are re-sent, because the engine's own session — not a replay of
                // stored turns — is what carries the conversation forward.
                const second = await service.turn(id, { text: 'a follow-up' });
                expect(second.content).toBe('a follow-up');

                expect(sessionAgentCalls).toHaveLength(1);
            } finally {
                planSessions.dispose(id);
            }
        });

        /**
         * Card 0141: `PlanService.turn` resolves the `claude-config-dir` setting fresh, only on a
         * `planSessions.session` miss, and hands the result to `PlanSessionAgent` as `configDir`.
         * The default `freshEnv()` service (used by every other test in this file) is constructed
         * with no `settings` at all, which resolves to `undefined` — this test constructs its own
         * `PlanService` with a real sixth argument to prove the resolved value actually reaches the
         * new engine session, not just that the plumbing compiles.
         */
        it('resolves the claude-config-dir setting on a session miss and passes it to the new PlanSessionAgent', async () => {
            const { board, config, worktrees } = await freshEnv();
            const settings = { get: vi.fn(async () => '/home/operator/.claude-wilson') } as unknown as SettingsStore;
            const service = new PlanService(board, config, worktrees, db, stageConfigs, settings);
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');

                await service.turn(id, { text: 'hi' });

                expect(settings.get).toHaveBeenCalledWith(CLAUDE_CONFIG_DIR);
                expect(sessionAgentCalls).toHaveLength(1);
                expect(sessionAgentCalls[0]!.configDir).toBe('/home/operator/.claude-wilson');
            } finally {
                planSessions.dispose(id);
            }
        });

        it('leaves configDir undefined for a card whose PlanService was constructed with no settings store', async () => {
            const { board, service } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');

                await service.turn(id, { text: 'hi' });

                expect(sessionAgentCalls).toHaveLength(1);
                expect(sessionAgentCalls[0]!.configDir).toBeUndefined();
            } finally {
                planSessions.dispose(id);
            }
        });

        it('returns only the generated PlanTurn shape — never the stored row\'s engine session id', async () => {
            const { board, service } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');

                const result = await service.turn(id, { text: 'hi' });

                expect(Object.keys(result).sort()).toEqual(['content', 'createdAt', 'role', 'seq']);
                expect(result).not.toHaveProperty('engineSessionId');
                expect(result.role).toBe('assistant');
                expect(result.seq).toBe(2); // 1 is the user turn just appended, 2 the assistant reply
            } finally {
                planSessions.dispose(id);
            }
        });

        it('appends the user turn then the assistant reply to the stored transcript, in seq order', async () => {
            const { board, service, config } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');
                await service.turn(id, { text: 'first message' });

                const repo = new PlanTurnRepository(config, db);
                const stored = await repo.since(id, 0);
                expect(stored.map(t => t.role)).toEqual(['user', 'assistant']);
                expect(stored[0]!.content).toBe('first message');
                expect(stored[1]!.engineSessionId).toBe(instances.at(-1)!.sessionId);
            } finally {
                planSessions.dispose(id);
            }
        });

        it('publishes each assistant chunk to planFeed as it is produced, not only once the turn completes', async () => {
            const { board, service } = await freshEnv();
            const id = randomUUID();
            const seen: string[] = [];
            const unsubscribe = planFeed.onEvent({ correlationId: id }, event => {
                seen.push(String(event.message));
            });
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');
                await service.turn(id, { text: 'alpha beta gamma' });

                expect(seen.length).toBeGreaterThan(1);
                expect(seen.join('')).toContain('alpha beta gamma');
            } finally {
                unsubscribe();
                planSessions.dispose(id);
            }
        });

        it('after close (simulating a process restart), a further turn resumes the previous engine session instead of starting a fresh one', async () => {
            const { board, service, config } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');

                await service.turn(id, { text: 'first' });
                expect(sessionAgentCalls).toHaveLength(1);
                expect(sessionAgentCalls[0]!.resume).toBeUndefined();
                const firstEngineSessionId = instances.at(-1)!.sessionId;

                await service.close(id);
                expect(disposeSpy).toHaveBeenCalledTimes(1);

                await service.turn(id, { text: 'second, after restart' });

                expect(sessionAgentCalls).toHaveLength(2);
                expect(sessionAgentCalls[1]!.resume).toBe(firstEngineSessionId);

                const repo = new PlanTurnRepository(config, db);
                const stored = await repo.since(id, 0);
                expect(stored.map(t => t.content)).toEqual([
                    'first',
                    expect.stringContaining('first'),
                    'second, after restart',
                    'second, after restart',
                ]);
            } finally {
                planSessions.dispose(id);
            }
        });

        it('close disposes the live session but leaves the stored transcript untouched', async () => {
            const { board, service, config } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'planning' }, FULL_BODY), 'seed');
                await service.turn(id, { text: 'keep me' });

                await service.close(id);

                const repo = new PlanTurnRepository(config, db);
                const stored = await repo.since(id, 0);
                expect(stored.map(t => t.content)).toEqual(['keep me', expect.stringContaining('keep me')]);
                expect(disposeSpy).toHaveBeenCalledTimes(1);
            } finally {
                planSessions.dispose(id);
            }
        });

        it('refuses a turn for a card outside "planning", storing nothing and starting no engine session', async () => {
            const { board, service, config } = await freshEnv();
            const id = randomUUID();
            await board.create(card(id, { stage: 'implementing' }), 'seed');

            await expect(service.turn(id, { text: 'hi' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('can only be talked through in "planning" or "parking-lot"') },
            });

            const repo = new PlanTurnRepository(config, db);
            expect(await repo.since(id, 0)).toEqual([]);
            expect(sessionAgentCalls).toHaveLength(0);
        });

        it('refuses a turn for a card whose real branch already has work, storing nothing', async () => {
            const { board, service, worktrees, config } = await freshEnv();
            const id = randomUUID();
            const title = 'Has code already';
            await board.create(card(id, { stage: 'planning', title }), 'seed');

            const cardBranch = worktrees.branchName(id, title);
            const cardWorktree = await worktrees.create(id, cardBranch);
            await writeFile(join(cardWorktree.path, 'src', 'feature.ts'), 'export const f = 1;\n', 'utf8');
            await worktrees.commit(cardWorktree, 'implementing');

            await expect(service.turn(id, { text: 'hi' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining(cardBranch) },
            });

            const repo = new PlanTurnRepository(config, db);
            expect(await repo.since(id, 0)).toEqual([]);
            expect(sessionAgentCalls).toHaveLength(0);
        });

        /**
         * Card 0159: `turn` shares `assertPlannable` with `open` (card 0058's guards), so relaxing
         * the stage check must reach here too — a parked card can hold a turn of conversation, not
         * only have its session opened.
         */
        it('accepts a turn for a card in "parking-lot", storing it and starting an engine session', async () => {
            const { board, service, config } = await freshEnv();
            const id = randomUUID();
            try {
                await board.create(card(id, { stage: 'parking-lot' }, FULL_BODY), 'seed');

                const turn = await service.turn(id, { text: 'talk this through' });

                expect(turn.content).toContain('talk this through');
                const repo = new PlanTurnRepository(config, db);
                expect(await repo.since(id, 0)).not.toEqual([]);
                expect(sessionAgentCalls).toHaveLength(1);
            } finally {
                planSessions.dispose(id);
            }
        });

        it('404s for a card that does not exist', async () => {
            const { service } = await freshEnv();
            await expect(service.turn('9999', { text: 'hi' })).rejects.toMatchObject({ statusCode: 404 });
        });
    });
});
