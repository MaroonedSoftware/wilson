import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { LeaseService } from '#modules/lease/lease.service.js';
import { DevServerPortAllocator } from '#modules/lease/dev.server.port.allocator.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

const silentLogger: Logger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
};

/**
 * Card 0165. Exercises `wilson.leases` against the real test database, which the suite's
 * `globalSetup` (test.db.migrate.ts) has already migrated.
 */
let db: Kysely<DB>;
let leases: LeaseService;

beforeAll(async () => {
    db = testDb();
    const boardRepo = new PostgresBoardRepository(
        new StaticBoardConfig('lease-service-test', '/tmp/code', '/tmp/wt', '/tmp/run'),
        db,
        new EventLog(db, silentLogger),
    );
    leases = new LeaseService(db, boardRepo);
});

afterAll(async () => {
    await db.destroy();
});

/**
 * `resource_key` is the primary key across the whole `wilson.leases` table — not scoped by project
 * (that is the point of card 0165) — so every test needs its own resource key or it would collide
 * with every other test in this file, and with any other suite that ever touches this table.
 */
const uniqueResourceKey = (): string => `test-resource-${randomUUID()}`;

const insertCard = (project: string, id: string): Promise<unknown> =>
    db
        .insertInto('wilson.cards')
        .values({
            project,
            id,
            title: `card ${id}`,
            stage: 'implementing',
            branch: null,
            body: '',
            retries: JSON.stringify({}),
            external: null,
            sourceClosed: null,
            needsHuman: false,
            needsHumanReason: null,
        })
        .execute();

/** The live claim `CardStageJob` would hold while actually carrying a card — see `hasLiveClaim`. */
const recordLiveClaim = (project: string, cardId: string): Promise<unknown> =>
    db
        .insertInto('wilson.cardJobs')
        .values({ project, cardId, jobId: `job-${randomUUID()}` })
        .execute();

describe('LeaseService.acquire', () => {
    it('takes an unheld resource', async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');

        const result = await leases.acquire(resourceKey, project, '0001');

        expect(result).toEqual({ acquired: true });
        await expect(leases.list()).resolves.toContainEqual({ resourceKey, project, cardId: '0001' });
    });

    /**
     * Acceptance criterion: "Two concurrent acquisitions of the same resource resolve to exactly
     * one holder, with the loser told it lost rather than throwing." `INSERT ... ON CONFLICT DO
     * NOTHING` is what makes this safe under real concurrency rather than merely under a mocked
     * sequential call, so this fires both acquisitions at once against the real pooled connection
     * and lets Postgres itself decide the winner.
     */
    it('resolves two concurrent acquisitions of the same resource to exactly one holder, telling the loser rather than throwing', async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');
        await insertCard(project, '0002');
        // Both must be genuinely running, or the loser's conflict resolves as an orphan sweep
        // (tested separately below) instead of the live contention this test is about.
        await recordLiveClaim(project, '0001');
        await recordLiveClaim(project, '0002');

        const [r1, r2] = await Promise.all([leases.acquire(resourceKey, project, '0001'), leases.acquire(resourceKey, project, '0002')]);

        const results = [
            { cardId: '0001', result: r1 },
            { cardId: '0002', result: r2 },
        ];
        const winners = results.filter(r => r.result.acquired);
        const losers = results.filter(r => !r.result.acquired);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);

        const loserResult = losers[0]!.result;
        if (loserResult.acquired) throw new Error('expected the loser to have lost');
        expect(loserResult.heldBy).toEqual({ resourceKey, project, cardId: winners[0]!.cardId });

        // Exactly one row, not two.
        const held = (await leases.list()).filter(l => l.resourceKey === resourceKey);
        expect(held).toEqual([{ resourceKey, project, cardId: winners[0]!.cardId }]);
    });

    /**
     * Acceptance criterion: "Two different registered projects contend for the same resource key,
     * and one of them loses — the key is machine-wide, not per-project." This is the constraint the
     * migration's comment calls out as the one thing to get right: `resource_key` alone is the
     * primary key, not `(project, resource_key)`.
     */
    it('lets two different projects contend for the same resource key, with one losing', async () => {
        const projectA = uniqueProject();
        const projectB = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(projectA, '0001');
        await insertCard(projectB, '0001');
        // Both running, so the second acquisition is a genuine loss, not an orphan sweep.
        await recordLiveClaim(projectA, '0001');
        await recordLiveClaim(projectB, '0001');

        const first = await leases.acquire(resourceKey, projectA, '0001');
        const second = await leases.acquire(resourceKey, projectB, '0001');

        expect(first).toEqual({ acquired: true });
        expect(second).toEqual({ acquired: false, heldBy: { resourceKey, project: projectA, cardId: '0001' } });
    });

    it('does not double-hold or deadlock when the same card acquires the same resource twice', async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');

        const first = await leases.acquire(resourceKey, project, '0001');
        const second = await leases.acquire(resourceKey, project, '0001');

        expect(first).toEqual({ acquired: true });
        expect(second).toEqual({ acquired: true });
        const held = (await leases.list()).filter(l => l.resourceKey === resourceKey);
        expect(held).toEqual([{ resourceKey, project, cardId: '0001' }]);
    });

    describe('a resource already held by another card', () => {
        it('is refused, told who holds it, while that holder is still running', async () => {
            const project = uniqueProject();
            const resourceKey = uniqueResourceKey();
            await insertCard(project, '0001');
            await insertCard(project, '0002');
            await recordLiveClaim(project, '0001');

            await expect(leases.acquire(resourceKey, project, '0001')).resolves.toEqual({ acquired: true });

            const result = await leases.acquire(resourceKey, project, '0002');
            expect(result).toEqual({ acquired: false, heldBy: { resourceKey, project, cardId: '0001' } });
        });

        /**
         * Acceptance criterion: "A lease held by a card that is no longer running can be acquired
         * by another card without manual intervention." No `wilson.card_jobs` row for '0001' is
         * exactly what "no longer running" means here (see `LeaseService.isOrphaned`'s doc), so this
         * models a daemon killed mid-stage without anything having to notice first.
         */
        it('is stolen automatically when the current holder is no longer running', async () => {
            const project = uniqueProject();
            const resourceKey = uniqueResourceKey();
            await insertCard(project, '0001');
            await insertCard(project, '0002');
            // Deliberately no recordLiveClaim: '0001' holds the lease but nothing is carrying it.

            await expect(leases.acquire(resourceKey, project, '0001')).resolves.toEqual({ acquired: true });

            const result = await leases.acquire(resourceKey, project, '0002');

            expect(result).toEqual({ acquired: true });
            const held = (await leases.list()).filter(l => l.resourceKey === resourceKey);
            expect(held).toEqual([{ resourceKey, project, cardId: '0002' }]);
        });
    });
});

describe('LeaseService.releaseAll', () => {
    it('releases every resource a card holds', async () => {
        const project = uniqueProject();
        const resourceKeyA = uniqueResourceKey();
        const resourceKeyB = uniqueResourceKey();
        await insertCard(project, '0001');
        await leases.acquire(resourceKeyA, project, '0001');
        await leases.acquire(resourceKeyB, project, '0001');

        await leases.releaseAll(project, '0001');

        const held = await leases.list();
        expect(held.some(l => l.resourceKey === resourceKeyA)).toBe(false);
        expect(held.some(l => l.resourceKey === resourceKeyB)).toBe(false);
    });

    it('leaves a stage slot alone, which the dispatcher releases itself when the stage ends', async () => {
        const project = uniqueProject();
        const slotKey = `host:${uniqueResourceKey()}:slot:1`;
        const portKey = uniqueResourceKey();
        await insertCard(project, '0001');
        await leases.acquire(slotKey, project, '0001');
        await leases.acquire(portKey, project, '0001');

        await leases.releaseAll(project, '0001');

        const held = await leases.list();
        expect(held.some(l => l.resourceKey === slotKey)).toBe(true);
        expect(held.some(l => l.resourceKey === portKey)).toBe(false);
        await leases.release(slotKey, project, '0001');
    });

    it('is safe to call for a card holding nothing', async () => {
        const project = uniqueProject();
        await insertCard(project, '0001');

        await expect(leases.releaseAll(project, '0001')).resolves.toBeUndefined();
    });

    it('lets a released resource be acquired again immediately', async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');
        await insertCard(project, '0002');
        await leases.acquire(resourceKey, project, '0001');

        await leases.releaseAll(project, '0001');

        await expect(leases.acquire(resourceKey, project, '0002')).resolves.toEqual({ acquired: true });
    });

    /**
     * Card ids are per-project (card 0149), so `releaseAll` must scope by `(project, cardId)`
     * together, not `cardId` alone — otherwise releasing card '0001' in one project would release a
     * same-numbered but unrelated card's leases in another, exactly the bug the doc comment on
     * `releaseAll` calls out.
     */
    it('does not release a same-numbered card in a different project', async () => {
        const projectA = uniqueProject();
        const projectB = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(projectA, '0001');
        await insertCard(projectB, '0001');
        await leases.acquire(resourceKey, projectB, '0001');

        await leases.releaseAll(projectA, '0001');

        await expect(leases.list()).resolves.toContainEqual({ resourceKey, project: projectB, cardId: '0001' });
    });
});

/**
 * Card 0167. `release` is the one addition this card makes: give back a single resource without
 * dropping every other lease the same card holds, which is what `releaseAll` above would do.
 */
describe('LeaseService.release', () => {
    it("releases one resource, leaving the same card's other leases held", async () => {
        const project = uniqueProject();
        const resourceKeyA = uniqueResourceKey();
        const resourceKeyB = uniqueResourceKey();
        await insertCard(project, '0001');
        await leases.acquire(resourceKeyA, project, '0001');
        await leases.acquire(resourceKeyB, project, '0001');

        await leases.release(resourceKeyA, project, '0001');

        const held = await leases.list();
        expect(held.some(l => l.resourceKey === resourceKeyA)).toBe(false);
        expect(held).toContainEqual({ resourceKey: resourceKeyB, project, cardId: '0001' });
    });

    it('frees nothing when the resource is held by a different card', async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');
        await insertCard(project, '0002');
        await leases.acquire(resourceKey, project, '0001');

        await leases.release(resourceKey, project, '0002');

        await expect(leases.list()).resolves.toContainEqual({ resourceKey, project, cardId: '0001' });
    });

    it('is not an error to release a resource nobody holds', async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');

        await expect(leases.release(resourceKey, project, '0001')).resolves.toBeUndefined();
    });

    /**
     * The same condition `acquire`'s own steal-path `DELETE` applies, exercised end to end: '0001'
     * once held this key but it was swept as orphaned and stolen by '0002' (see "is stolen
     * automatically..." above). '0001' calling `release` on a key it no longer actually holds must
     * delete nothing — in particular, it must not free '0002''s current claim just because the
     * resource key and project match.
     */
    it("does not release the current holder's claim when the caller no longer actually holds the key", async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');
        await insertCard(project, '0002');
        // Deliberately no recordLiveClaim for '0001', so '0002' below steals it as orphaned.
        await expect(leases.acquire(resourceKey, project, '0001')).resolves.toEqual({ acquired: true });
        await expect(leases.acquire(resourceKey, project, '0002')).resolves.toEqual({ acquired: true });

        await leases.release(resourceKey, project, '0001');

        await expect(leases.list()).resolves.toContainEqual({ resourceKey, project, cardId: '0002' });
    });

    it('lets a released resource be acquired again immediately, by another card', async () => {
        const project = uniqueProject();
        const resourceKey = uniqueResourceKey();
        await insertCard(project, '0001');
        await insertCard(project, '0002');
        await leases.acquire(resourceKey, project, '0001');

        await leases.release(resourceKey, project, '0001');

        await expect(leases.acquire(resourceKey, project, '0002')).resolves.toEqual({ acquired: true });
    });
});

/**
 * Card 0167's motivating caller, wired up for real: `DevServerPortAllocator` on top of the real
 * `LeaseService` above (not the stub `dev.server.port.allocator.test.ts` uses), with a real socket
 * bound to model "the machine already has this port". Acceptance criterion: "After an allocation
 * that steps over ports the machine already has bound, only the port actually returned is still
 * leased by that card."
 */
describe('DevServerPortAllocator.acquire, against the real LeaseService', () => {
    const occupied: Server[] = [];
    afterEach(async () => {
        await Promise.all(occupied.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    });

    const occupy = (port: number): Promise<Server> =>
        new Promise((resolve, reject) => {
            const server = createServer();
            server.once('error', reject);
            server.listen(port, () => resolve(server));
        });

    it('leaves only the port actually returned leased, after stepping over one already bound on this machine', async () => {
        const project = uniqueProject();
        await insertCard(project, '0001');
        // A high, randomised port so concurrent test files binding their own ports do not collide.
        const port = 47000 + randomInt(2000);
        occupied.push(await occupy(port));
        const allocator = new DevServerPortAllocator(leases);

        const result = await allocator.acquire({ start: port, end: port + 1 }, project, '0001');

        expect(result).toEqual({ ok: true, port: port + 1 });
        const held = (await leases.list()).filter(l => l.project === project);
        expect(held).toEqual([{ resourceKey: `port:${port + 1}`, project, cardId: '0001' }]);
    });
});
