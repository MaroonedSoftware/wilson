import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import type { EventLog } from '#modules/events/event.log.js';
import { DiffSource, type DiffResult } from '#modules/review/review.diff.source.js';
import { ReviewService } from '#modules/review/review.service.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const PATCH = ['@@ -1,3 +1,3 @@', ' first', '-gone', '+added', ' third', ''].join('\n');
const fileWith = (patch: string): DiffFileEntry => ({ path: 'a.ts', status: 'modified', patch, truncated: false });

/** A branch the test moves by hand, so a review's relationship to its head is the thing under test. */
class FakeDiffSource extends DiffSource {
    current: DiffResult = { ok: true, head: 'sha-1', base: 'base-1', files: [fileWith(PATCH)], truncated: false };

    async head(): Promise<string | undefined> {
        return this.current.ok ? this.current.head : undefined;
    }

    async read(): Promise<DiffResult> {
        return this.current;
    }

    moveTo(head: string, patch = PATCH): void {
        this.current = { ok: true, head, base: 'base-1', files: [fileWith(patch)], truncated: false };
    }
}

const card = (id: string, stage = 'ready'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage, dependsOn: [], retries: {} },
    sections: {},
    body: 'body text',
});

const fresh = async (stage = 'ready') => {
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = new PostgresBoardRepository(config, db, { append: vi.fn(async () => {}) } as unknown as EventLog);
    await board.create(card('0001', stage), 'seed');
    const diffs = new FakeDiffSource();
    return { board, diffs, service: new ReviewService(board, config, diffs, db) };
};

const onAdded = { head: 'sha-1', file: 'a.ts', side: 'new' as const, line: 2, text: 'not like this' };

describe('ReviewService', () => {
    describe('state', () => {
        it('answers a card nobody has reviewed with no review and no comments, in any stage', async () => {
            const { service } = await fresh('implementing');

            await expect(service.state('0001')).resolves.toEqual({ review: undefined, comments: [] });
        });

        it('answers a missing card with a 404', async () => {
            const { service } = await fresh();

            await expect(service.state('9999')).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    describe('open', () => {
        it('binds a new review to the current head', async () => {
            const { service } = await fresh();

            const { review } = await service.open('0001');

            expect(review).toMatchObject({ head: 'sha-1', base: 'base-1', status: 'open', stale: false });
        });

        it('rejoins the same review at the same head', async () => {
            const { service } = await fresh();

            const first = await service.open('0001');
            const second = await service.open('0001');

            expect(second.review!.id).toBe(first.review!.id);
        });

        it('reads as stale once the branch moves, then retires for a new review when reopened', async () => {
            const { diffs, service } = await fresh();
            const first = await service.open('0001');

            diffs.moveTo('sha-2');
            const seen = await service.state('0001');
            const reopened = await service.open('0001');

            expect(seen.review).toMatchObject({ id: first.review!.id, stale: true });
            expect(reopened.review).toMatchObject({ head: 'sha-2', status: 'open', stale: false });
            expect(reopened.review!.id).not.toBe(first.review!.id);
        });

        it('leaves one open review when two people open at once', async () => {
            const { service } = await fresh();

            const [one, two] = await Promise.all([service.open('0001'), service.open('0001')]);

            expect(one.review!.id).toBe(two.review!.id);
        });

        it('refuses a card outside ready, and a card with no branch', async () => {
            const notReady = await fresh('implementing');
            await expect(notReady.service.open('0001')).rejects.toMatchObject({ statusCode: 400 });

            const noBranch = await fresh();
            noBranch.diffs.current = { ok: false, reason: 'card/0001 has no branch yet' };
            await expect(noBranch.service.open('0001')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: 'card/0001 has no branch yet' },
            });
        });
    });

    describe('addComment', () => {
        it('stores the anchor from the diff and defaults to a blocker', async () => {
            const { service } = await fresh();

            const comment = await service.addComment('0001', onAdded);
            const { comments, review } = await service.state('0001');

            expect(comment).toMatchObject({
                lineText: 'added',
                severity: 'blocker',
                status: 'open',
                location: 'found',
                currentLine: 2,
                head: 'sha-1',
            });
            expect(comments).toEqual([comment]);
            expect(review!.id).toBe(comment.reviewId);
        });

        it('accepts a comment on a removed line', async () => {
            const { service } = await fresh();

            const comment = await service.addComment('0001', { ...onAdded, side: 'old', line: 2 });

            expect(comment).toMatchObject({ side: 'old', lineText: 'gone', location: 'found', currentLine: 2 });
        });

        it('answers a moved branch with a 409', async () => {
            const { diffs, service } = await fresh();
            diffs.moveTo('sha-2');

            await expect(service.addComment('0001', onAdded)).rejects.toMatchObject({ statusCode: 409 });
        });

        it('refuses a line the diff does not show, empty text, and a card outside ready', async () => {
            const { service } = await fresh();
            await expect(service.addComment('0001', { ...onAdded, line: 99 })).rejects.toMatchObject({ statusCode: 400 });
            await expect(service.addComment('0001', { ...onAdded, text: '   ' })).rejects.toMatchObject({ statusCode: 400 });

            const notReady = await fresh('implementing');
            await expect(notReady.service.addComment('0001', onAdded)).rejects.toMatchObject({ statusCode: 400 });
        });

        it('carries comments over to a new head, located against it', async () => {
            const { diffs, service } = await fresh();
            await service.addComment('0001', onAdded);
            await service.addComment('0001', { ...onAdded, line: 3, text: 'about the third' });

            diffs.moveTo('sha-2', ['@@ -5,2 +5,2 @@', ' other', '+added', ''].join('\n'));
            const { comments } = await service.open('0001');

            expect(comments.map(comment => [comment.location, comment.currentLine])).toEqual([
                ['found', 6],
                ['outdated', undefined],
            ]);
        });
    });

    describe('resolveComment', () => {
        it('moves a comment to resolved and keeps it on record', async () => {
            const { service } = await fresh();
            const comment = await service.addComment('0001', onAdded);

            const resolved = await service.resolveComment('0001', comment.id);

            expect(resolved.status).toBe('resolved');
            expect((await service.state('0001')).comments.map(stored => stored.status)).toEqual(['resolved']);
        });

        it("answers a comment that is not this card's, or not a number, with a 404", async () => {
            const { service } = await fresh();

            await expect(service.resolveComment('0001', '999999999')).rejects.toMatchObject({ statusCode: 404 });
            await expect(service.resolveComment('0001', 'abc')).rejects.toMatchObject({ statusCode: 404 });
        });
    });
});
