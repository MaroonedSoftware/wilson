import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { PlanService } from '#modules/plan/plan.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import type { Card } from '#modules/board/card.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { DB } from '#modules/data/db.js';
import { planSessions } from '#modules/plan/plan.session.registry.js';
import { StaticLearningsStore } from '#modules/learnings/learnings.store.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };
const fakeEvents = { append: vi.fn(async () => {}) } as unknown as EventLog;

/**
 * Card 0244: `PlanService.appendTurn` now prepends a `learningsBlock` preamble — the project's
 * learnings document — on a card's first planning turn only, beside `contextBlock` and
 * `commentsBlock`. Framed the opposite of `contextBlock`: the document is human-write-only
 * (PROJECT.md decision 8), so it reads as guidance to follow, not material to weigh. An empty or
 * absent document means "no learnings" — no preamble at all, and the prompt is byte-identical to
 * what it was before this card.
 *
 * `PlanSessionAgent` is replaced with the same bare double `plan.service.test.ts` uses, so what's
 * under test is the prompt `PlanService` composes, not a real engine call.
 */
const { PlanSessionAgentMock } = vi.hoisted(() => {
    class PlanSessionAgentMock {
        sessionId: string | undefined = 'engine-session-1';
        async *turn(text: string): AsyncGenerator<string> {
            const words = text.split(' ');
            for (const [index, word] of words.entries()) {
                yield index === 0 ? word : ` ${word}`;
            }
        }
        dispose(): void {}
    }
    return { PlanSessionAgentMock };
});

vi.mock('#modules/agent/plan.session.agent.js', () => ({ PlanSessionAgent: PlanSessionAgentMock }));

const card = (id: string, body: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'planning', dependsOn: [], retries: {} },
    sections: {},
    body,
});

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

let db: Kysely<DB>;

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
        '    onPass: merged',
        '    onFail: implementing',
        '',
    ].join('\n'),
);

beforeAll(async () => {
    db = testDb();
});

afterAll(async () => {
    await db.destroy();
});

const freshEnv = async (learnings?: StaticLearningsStore) => {
    const base = await mkdtemp(join(tmpdir(), 'plan-service-0244-'));
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
    const config = new StaticBoardConfig(uniqueProject(), codeRoot, worktreeRoot, runRoot);
    const board = new PostgresBoardRepository(config, db, fakeEvents);
    const worktrees = new WorktreeManager(config, silentLogger as never);
    const service = new PlanService(board, config, worktrees, db, stageConfigs, undefined, learnings);

    return { board, service };
};

describe('PlanService first-turn learnings preamble (card 0244)', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("AC4: the first turn carries the learnings preamble, after the stage instructions and before the operator's own text", async () => {
        const learnings = new StaticLearningsStore('# Lessons\n\nAlways run the build before reporting.\n');
        const { board, service } = await freshEnv(learnings);
        const id = randomUUID();
        try {
            await board.create(card(id, FULL_BODY), 'seed');

            const result = await service.turn(id, { text: 'hello there' });

            const instructionsIdx = result.content.indexOf('Write a plan for this card');
            const learningsIdx = result.content.indexOf('Always run the build before reporting.');
            const textIdx = result.content.indexOf('hello there');

            expect(instructionsIdx).toBeGreaterThanOrEqual(0);
            expect(learningsIdx).toBeGreaterThan(instructionsIdx);
            expect(textIdx).toBeGreaterThan(learningsIdx);
            expect(result.content).toContain('human-approved');
        } finally {
            planSessions.dispose(id);
        }
    });

    it('AC4: a later turn in the same conversation carries no learnings preamble', async () => {
        const learnings = new StaticLearningsStore('# Lessons\n\nAlways run the build before reporting.\n');
        const { board, service } = await freshEnv(learnings);
        const id = randomUUID();
        try {
            await board.create(card(id, FULL_BODY), 'seed');

            await service.turn(id, { text: 'first message' });
            const second = await service.turn(id, { text: 'second message' });

            expect(second.content).toBe('second message');
            expect(second.content).not.toContain('Always run the build before reporting.');
        } finally {
            planSessions.dispose(id);
        }
    });

    it("AC5: an empty document adds no preamble — the first turn's prompt is byte-identical to what it would be with no learnings store at all", async () => {
        const emptyLearnings = new StaticLearningsStore('');
        const { board, service } = await freshEnv(emptyLearnings);
        const id = randomUUID();
        try {
            await board.create(card(id, FULL_BODY), 'seed');
            const session = await service.open(id);

            const result = await service.turn(id, { text: 'hello there' });

            expect(result.content).not.toContain('learnings');
            expect(result.content).not.toContain('human-approved');
            expect(result.content).toBe(`${session.instructions}\n\nhello there`);
        } finally {
            planSessions.dispose(id);
        }
    });

    it('AC5: a PlanService constructed with no LearningsStore at all behaves the same as an empty document', async () => {
        const { board, service } = await freshEnv(undefined);
        const id = randomUUID();
        try {
            await board.create(card(id, FULL_BODY), 'seed');
            const session = await service.open(id);

            const result = await service.turn(id, { text: 'hello there' });

            expect(result.content).toBe(`${session.instructions}\n\nhello there`);
        } finally {
            planSessions.dispose(id);
        }
    });
});
