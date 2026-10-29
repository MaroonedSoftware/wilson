import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { Logger } from '@maroonedsoftware/logger';
import type { DB } from '#modules/data/db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { HostConnector } from '#modules/host/host.connector.js';
import { HostPlacer, NoHostAvailable } from '#modules/host/host.placer.js';
import { HostRepository } from '#modules/host/host.repository.js';
import { HostsService } from '#modules/host/hosts.service.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import { SshGitTransport } from '#modules/host/ssh.git.transport.js';
import { LeaseService } from '#modules/lease/lease.service.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * Placement against the real `wilson.hosts` and `wilson.leases`, with the stand-in `ssh` for the
 * reachability check. A slot taken by another card only counts as held while that card has a live
 * claim, which is how `LeaseService` tells a running stage from one a killed daemon left behind.
 */
const FAKE_SSH = fileURLToPath(new URL('../../support/fake.ssh.sh', import.meta.url));
const silentLogger = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
} as Logger;

let db: Kysely<DB>;
let hosts: HostRepository;
let service: HostsService;
let leases: LeaseService;
let unreachableSsh: string;

beforeAll(async () => {
    db = testDb();
    hosts = new HostRepository(db);
    service = new HostsService(hosts, new ProjectRepository(db));
    const boardRepo = new PostgresBoardRepository(
        new StaticBoardConfig('host-placer-test', '/tmp/code', '/tmp/wt', '/tmp/run'),
        db,
        new EventLog(db, silentLogger),
    );
    leases = new LeaseService(db, boardRepo);

    unreachableSsh = join(await mkdtemp(join(tmpdir(), 'host-placer-')), 'ssh');
    await writeFile(unreachableSsh, '#!/bin/sh\necho "ssh: Could not resolve hostname" >&2\nexit 255\n', 'utf8');
    await chmod(unreachableSsh, 0o755);
});

afterAll(async () => {
    await db.destroy();
});

const placer = (ssh = FAKE_SSH) => new HostPlacer(hosts, new HostConnector(ssh), leases, silentLogger);

const insertCard = (project: string, id: string) =>
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

const recordLiveClaim = (project: string, cardId: string) =>
    db
        .insertInto('wilson.cardJobs')
        .values({ project, cardId, jobId: `job-${randomUUID()}` })
        .execute();

/** A project with a card, and a host serving it that last probed fine and expires in `hoursLeft`. */
const setUp = async (options: { slots?: number; hoursLeft?: number; probeOk?: boolean } = {}) => {
    const project = uniqueProject();
    await new ProjectRepository(db).create({ name: project, codeRoot: '/tmp/code', worktreeRoot: '/tmp/wt', runRoot: '/tmp/run' });
    await insertCard(project, '0001');
    await insertCard(project, '0002');

    const name = uniqueProject();
    await service.create({ name, slots: options.slots ?? 1 });
    await service.putProject(name, project, { codeRoot: '/opt/agent/TGA', worktreeRoot: '/opt/agent/wt', runRoot: '/opt/agent/run' });
    await hosts.recordProbe(name, {
        probedAt: DateTime.now(),
        ok: options.probeOk ?? true,
        ...(options.hoursLeft !== undefined && { expiresAt: DateTime.now().plus({ hours: options.hoursLeft }) }),
    });
    return { project, name };
};

const stage = (placement: 'local' | 'any' | 'remote') => ({ placement, worktree: 'rw' as const, maxWallClockMs: 30 * 60 * 1000 });

describe('HostPlacer', () => {
    it('places nothing for a local stage, or one with no worktree', async () => {
        const { project } = await setUp();
        expect(await placer().place(project, '0001', stage('local'))).toBeUndefined();
        expect(await placer().place(project, '0001', { ...stage('remote'), worktree: 'none' })).toBeUndefined();
    });

    it('places a stage on a host serving its project, holding a slot there with the project’s paths', async () => {
        const { project, name } = await setUp();

        const placed = (await placer().place(project, '0001', stage('remote'))) as RemotePlacement;

        expect(placed).toMatchObject({
            hostName: name,
            codeRoot: '/opt/agent/TGA',
            worktreeRoot: '/opt/agent/wt',
            runRoot: '/opt/agent/run',
        });
        expect(placed.git).toBeInstanceOf(SshGitTransport);
        expect(placed.slotKey).toBe(`host:${name}:slot:1`);
        expect(await leases.list()).toContainEqual({ resourceKey: placed.slotKey, project, cardId: '0001' });
        // And the host reports the slot as running that card.
        expect((await service.get(name)).running).toEqual([{ slot: 1, project, cardId: '0001', since: expect.anything() }]);
    });

    it('defers a remote stage when every slot is held by a running card, and runs an `any` stage here', async () => {
        const { project, name } = await setUp();
        await recordLiveClaim(project, '0001');
        await placer().place(project, '0001', stage('remote'));

        const remote = await placer().place(project, '0002', stage('remote'));
        expect(remote).toBeInstanceOf(NoHostAvailable);
        expect((remote as NoHostAvailable).message).toContain(`${name} has all 1 slot in use`);

        expect(await placer().place(project, '0002', stage('any'))).toBeUndefined();
    });

    it('takes a slot back from a card that is no longer running', async () => {
        const { project } = await setUp();
        await placer().place(project, '0001', stage('remote'));

        // 0001 has no live claim, so its slot is a killed daemon's leftover, not a running stage.
        const placed = (await placer().place(project, '0002', stage('remote'))) as RemotePlacement;
        expect(placed.slotKey).toMatch(/:slot:1$/);
    });

    it('passes over a host that will expire before the stage could finish, or failed its probe', async () => {
        const expiring = await setUp({ hoursLeft: 0.5 });
        const result = await placer().place(expiring.project, '0001', stage('remote'));
        expect((result as NoHostAvailable).message).toContain('before the stage could finish');

        const failing = await setUp({ probeOk: false });
        expect(((await placer().place(failing.project, '0001', stage('remote'))) as NoHostAvailable).message).toContain('failed its last probe');
    });

    it('passes over a disabled or draining host', async () => {
        const { project, name } = await setUp();
        await service.update(name, { draining: true });
        expect(((await placer().place(project, '0001', stage('remote'))) as NoHostAvailable).message).toContain(`${name} is draining`);

        await service.update(name, { draining: false, enabled: false });
        expect(((await placer().place(project, '0001', stage('remote'))) as NoHostAvailable).message).toContain(`${name} is disabled`);
    });

    it('takes this machine’s slots up to local-stage-slots, then reports them busy, and frees one on release', async () => {
        const { project } = await setUp();
        await recordLiveClaim(project, '0001');
        await recordLiveClaim(project, '0002');
        const settings = { get: async () => 1 };
        const local = new HostPlacer(hosts, new HostConnector(FAKE_SSH), leases, silentLogger, settings as never);

        // `local:slot:1` is machine-wide; a holder left by an earlier run has no live claim, so it is swept.
        const first = await local.takeLocalSlot(project, '0001');
        expect(first).toEqual({ key: 'local:slot:1' });
        expect(await local.takeLocalSlot(project, '0002')).toEqual({ busy: 1 });

        await local.releaseSlot('local:slot:1', project, '0001');
        expect(await local.takeLocalSlot(project, '0002')).toEqual({ key: 'local:slot:1' });
        await local.releaseSlot('local:slot:1', project, '0002');
    });

    it('passes a host over once it is marked lost, until a probe passes again', async () => {
        const { project, name } = await setUp();
        const placed = (await placer().place(project, '0001', stage('remote'))) as RemotePlacement;
        expect(await placer().isAlive(placed)).toBe(true);

        await placer().markLost(placed, '0001 implementing: engine exited');

        const host = await service.get(name);
        expect(host.probe).toMatchObject({ ok: false, detail: 'lost during a stage: 0001 implementing: engine exited' });
        expect(((await placer().place(project, '0002', stage('remote'))) as NoHostAvailable).message).toContain('failed its last probe');
    });

    it('gives the slot back when the host does not answer', async () => {
        const { project, name } = await setUp();

        const result = await placer(unreachableSsh).place(project, '0001', stage('remote'));

        expect((result as NoHostAvailable).message).toContain(`${name} did not answer`);
        expect((await leases.list()).some(lease => lease.resourceKey.startsWith(`host:${name}:`))).toBe(false);
    });
});
