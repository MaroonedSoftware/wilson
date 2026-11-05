import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { EvalFixtureRepository } from '#modules/evals/eval.fixture.repository.js';
import { EvalFixturesService } from '#modules/evals/eval.fixtures.service.js';
import { EventLog } from '#modules/events/event.log.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const card = (id: string, extra: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: 'do the thing', stage: 'backlog', dependsOn: [], retries: {}, ...extra },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nThe plan as approved.\n\n## Files in scope\n\n- src/x.ts\n',
});

const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', args, { cwd })).stdout.trim();

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('EvalFixturesService', () => {
    let codeRoot: string;
    let baseSha: string;
    let headSha: string;
    let events: EventLog;
    let board: PostgresBoardRepository;
    let service: EvalFixturesService;
    let project: string;

    beforeEach(async () => {
        codeRoot = await mkdtemp(join(tmpdir(), 'eval-fixtures-'));
        await gitIn(codeRoot, 'init', '-q', '-b', 'main');
        await gitIn(codeRoot, 'config', 'user.email', 'test@example.com');
        await gitIn(codeRoot, 'config', 'user.name', 'test');
        await writeFile(join(codeRoot, 'x.ts'), 'one\n');
        await gitIn(codeRoot, 'add', '-A');
        await gitIn(codeRoot, 'commit', '-qm', 'base');
        baseSha = await gitIn(codeRoot, 'rev-parse', 'HEAD');
        await writeFile(join(codeRoot, 'x.ts'), 'two\n');
        await gitIn(codeRoot, 'commit', '-qam', 'the card');
        headSha = await gitIn(codeRoot, 'rev-parse', 'HEAD');

        project = uniqueProject();
        const config = new StaticBoardConfig(project, codeRoot, join(codeRoot, 'wt'), join(codeRoot, 'run'));
        events = new EventLog(db, silentLogger as never);
        board = new PostgresBoardRepository(config, db, events);
        service = new EvalFixturesService(config, board, new EvalFixtureRepository(config, db));
    });

    const logAttempt = async (cardId: string, base = baseSha, head = headSha) => {
        await events.append({ project, cardId, stage: 'implementing', type: 'worktree.created', payload: { baseSha: base } });
        await events.append({ project, cardId, stage: 'implementing', type: 'stage.dispatched', payload: {} });
        await events.append({ project, cardId, stage: 'implementing', type: 'work.committed', payload: { sha: head } });
        await events.append({ project, cardId, stage: 'implementing', type: 'stage.passed', payload: {} });
        await events.append({ project, cardId, stage: 'review', type: 'worktree.created', payload: { baseSha: base } });
        await events.append({ project, cardId, stage: 'review', type: 'stage.dispatched', payload: {} });
    };

    it('copies the plan as the attempt read it, and pins both commits', async () => {
        await board.create(card('0001'), 'initial');
        const approved = await board.write('0001', 'approved text', current => current);
        await board.write('0001', 'pin', current => ({ ...current, frontmatter: { ...current.frontmatter, planVersionId: approved } }));
        await logAttempt('0001');
        await board.write('0001', 'later edit', current => ({ ...current, body: 'a later edit' }));

        const fixture = await service.capture({ cardId: '0001', stage: 'review' });

        expect(fixture).toMatchObject({ sourceCardId: '0001', stage: 'review', planVersionId: approved, baseSha, headSha, warnings: [] });
        const stored = await db.selectFrom('wilson.evalFixtures').select('plan').where('id', '=', BigInt(fixture.id)).executeTakeFirstOrThrow();
        expect((stored.plan as unknown as Card).body).toContain('The plan as approved.');
        expect(await gitIn(codeRoot, 'rev-parse', `refs/wilson/eval/${fixture.id}/base`)).toBe(baseSha);
        expect(await gitIn(codeRoot, 'rev-parse', `refs/wilson/eval/${fixture.id}/head`)).toBe(headSha);
    });

    it('changes nothing about the card', async () => {
        await board.create(card('0002'), 'initial');
        await logAttempt('0002');
        const before = await board.currentVersion('0002');

        await service.capture({ cardId: '0002', stage: 'review' });

        expect(await board.currentVersion('0002')).toBe(before);
        expect((await board.read('0002')).frontmatter.stage).toBe('backlog');
    });

    it('warns about a split card, whose plan may cite a patch a replay will not have', async () => {
        await board.create(card('0030'), 'initial');
        await board.create(card('0003', { splitFrom: '0030' }), 'initial');
        await logAttempt('0003');

        const fixture = await service.capture({ cardId: '0003', stage: 'review' });

        expect(fixture.warnings.join()).toContain('split from 0030');
    });

    it('reads what a review should find from the card’s own review, and lets a person replace it', async () => {
        await board.create(card('0009'), 'initial');
        await logAttempt('0009');
        const findings = [{ severity: 'blocker', file: 'x.ts', problem: 'p' }];
        await events.append({ project, cardId: '0009', stage: 'review', type: 'stage.passed', payload: { result: { verdict: 'revise', findings } } });

        const fixture = await service.capture({ cardId: '0009', stage: 'review' });
        expect(fixture.expected).toEqual({ verdict: 'revise', blockerFiles: ['x.ts'], source: 'attempt' });

        const labelled = await service.setExpected(fixture.id, { verdict: 'pass' });
        expect(labelled.expected).toEqual({ verdict: 'pass', blockerFiles: [], source: 'operator' });
        expect((await service.list()).find(f => f.id === fixture.id)?.expected?.source).toBe('operator');
    });

    it('refuses to label anything but a review, a pass naming blockers, or a missing fixture', async () => {
        await board.create(card('0010'), 'initial');
        await logAttempt('0010');
        const implementing = await service.capture({ cardId: '0010', stage: 'implementing' });
        await board.create(card('0011'), 'initial');
        await logAttempt('0011');
        const review = await service.capture({ cardId: '0011', stage: 'review' });

        expect(implementing.expected).toBeUndefined();
        await expect(service.setExpected(implementing.id, { verdict: 'pass' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.setExpected(review.id, { verdict: 'pass', blockerFiles: ['a.ts'] })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.setExpected('999999', { verdict: 'pass' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses a stage an eval cannot replay', async () => {
        await expect(service.capture({ cardId: '0001', stage: 'challenge' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuses an attempt the card has no record of', async () => {
        await board.create(card('0004'), 'initial');
        await expect(service.capture({ cardId: '0004', stage: 'review' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses a commit that is gone from the clone', async () => {
        await board.create(card('0005'), 'initial');
        await logAttempt('0005', baseSha, 'a'.repeat(40));
        await expect(service.capture({ cardId: '0005', stage: 'review' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses a head not built on its base', async () => {
        await board.create(card('0006'), 'initial');
        await logAttempt('0006', headSha, baseSha);
        await expect(service.capture({ cardId: '0006', stage: 'review' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses the same attempt twice', async () => {
        await board.create(card('0007'), 'initial');
        await logAttempt('0007');
        await service.capture({ cardId: '0007', stage: 'review' });
        await expect(service.capture({ cardId: '0007', stage: 'review' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('removes a fixture and its refs', async () => {
        await board.create(card('0008'), 'initial');
        await logAttempt('0008');
        const fixture = await service.capture({ cardId: '0008', stage: 'review' });

        await service.remove(fixture.id);

        expect(await service.list()).toEqual([]);
        await expect(gitIn(codeRoot, 'rev-parse', '--verify', `refs/wilson/eval/${fixture.id}/base`)).rejects.toThrow();
        await expect(service.remove(fixture.id)).rejects.toMatchObject({ statusCode: 404 });
    });
});
