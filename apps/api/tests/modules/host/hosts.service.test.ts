import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { HostRepository } from '#modules/host/host.repository.js';
import { HostsService } from '#modules/host/hosts.service.js';
import { eventually, FakeWorker, startWorkerServer } from '#tests/support/fake.worker.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * The host registry, against a real connection for the reason `project.repository.test.ts` gives:
 * a fake would only prove the test agrees with itself about what a write means. Host names come
 * from `uniqueProject()` too, since `wilson.hosts` is deployment-scoped and shared by every test.
 */
let db: Kysely<DB>;
let service: HostsService;
let hosts: HostRepository;
let projects: ProjectRepository;

beforeAll(() => {
    db = testDb();
    hosts = new HostRepository(db);
    projects = new ProjectRepository(db);
    service = new HostsService(hosts, projects);
});
afterAll(async () => {
    await db.destroy();
});

const registerProject = async (): Promise<string> => {
    const name = uniqueProject();
    await projects.create({ name, codeRoot: '/tmp/code', worktreeRoot: '/tmp/wt', runRoot: '/tmp/run' });
    return name;
};

describe('HostsService', () => {
    it('registers an SSH host by default, with its SSH target defaulting to its name and one slot', async () => {
        const name = uniqueProject();

        const host = await service.create({ name });

        expect(host).toEqual({
            name,
            kind: 'ssh',
            sshTarget: name,
            slots: 1,
            enabled: true,
            draining: false,
            isolated: false,
            commandEnv: [],
            projects: [],
            running: [],
        });
        expect(await service.list()).toContainEqual(host);
    });

    it('registers a worker host with no SSH target', async () => {
        const name = uniqueProject();

        const host = await service.create({ name, kind: 'worker', slots: 2 });

        expect(host).toEqual({
            name,
            kind: 'worker',
            slots: 2,
            enabled: true,
            draining: false,
            isolated: false,
            commandEnv: [],
            projects: [],
            running: [],
        });
        expect(await service.get(name)).toEqual(host);
    });

    it('refuses an SSH target for a worker host with 400, at registration and after', async () => {
        const name = uniqueProject();

        await expect(service.create({ name, kind: 'worker', sshTarget: 'box' })).rejects.toMatchObject({ statusCode: 400 });
        await service.create({ name, kind: 'worker' });
        await expect(service.setSshTarget(name, { sshTarget: 'box' })).rejects.toMatchObject({ statusCode: 400 });
        expect(await service.update(name, { draining: true })).toMatchObject({ kind: 'worker', draining: true });
    });

    it('keeps the kind and the SSH target in step in the table itself', async () => {
        await expect(db.insertInto('wilson.hosts').values({ name: uniqueProject(), kind: 'worker', sshTarget: 'box' }).execute()).rejects.toThrow();
        await expect(db.insertInto('wilson.hosts').values({ name: uniqueProject(), kind: 'ssh', sshTarget: null }).execute()).rejects.toThrow();
        await expect(
            db
                .insertInto('wilson.hosts')
                .values({ name: uniqueProject(), kind: 'pigeon' as never, sshTarget: 'box' })
                .execute(),
        ).rejects.toThrow();
    });

    it('refuses a taken name with 409, and a bad target or slot count with 400', async () => {
        const name = uniqueProject();
        await service.create({ name, sshTarget: 'agent-3', slots: 2 });

        await expect(service.create({ name })).rejects.toMatchObject({ statusCode: 409 });
        await expect(service.create({ name: uniqueProject(), sshTarget: '  ' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.create({ name: uniqueProject(), slots: 9 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.create({ name: uniqueProject(), slots: 0 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('updates only the fields a patch names, and 404s an unknown host', async () => {
        const name = uniqueProject();
        await service.create({ name, sshTarget: 'agent-1', slots: 2 });

        const drained = await service.update(name, { draining: true });
        expect(drained).toMatchObject({ sshTarget: 'agent-1', slots: 2, enabled: true, draining: true });

        const moved = await service.update(name, { enabled: false });
        expect(moved).toMatchObject({ sshTarget: 'agent-1', slots: 2, enabled: false, draining: true });

        expect(await service.update(name, {})).toEqual(moved);
        await expect(service.update(uniqueProject(), { slots: 1 })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('changes an SSH target on its own, refusing an empty one and an unknown host', async () => {
        const name = uniqueProject();
        await service.create({ name, sshTarget: 'agent-1', slots: 2 });

        expect(await service.setSshTarget(name, { sshTarget: 'agent-2' })).toMatchObject({ sshTarget: 'agent-2', slots: 2 });
        await expect(service.setSshTarget(name, { sshTarget: '  ' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.setSshTarget(uniqueProject(), { sshTarget: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('records a lifetime, clears it with 0, and refuses a negative one', async () => {
        const name = uniqueProject();

        expect(await service.create({ name, lifetimeMinutes: 720 })).toMatchObject({ lifetimeMinutes: 720 });
        expect(await service.update(name, { lifetimeMinutes: 0 })).not.toHaveProperty('lifetimeMinutes');
        await expect(service.update(name, { lifetimeMinutes: -5 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('records the variables a host supplies to commands, deduplicated, and refuses one that is not a name', async () => {
        const name = uniqueProject();

        expect((await service.create({ name, commandEnv: ['GITHUB_TOKEN', 'GITHUB_TOKEN'] })).commandEnv).toEqual(['GITHUB_TOKEN']);
        expect((await service.update(name, { commandEnv: ['GITHUB_TOKEN', 'NPM_TOKEN'] })).commandEnv).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN']);
        expect((await service.update(name, { commandEnv: [] })).commandEnv).toEqual([]);
        await expect(service.update(name, { commandEnv: ['A"; rm -rf /'] })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.create({ name: uniqueProject(), commandEnv: ['1BAD'] })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('sets a project’s paths on a host, replaces them on a second put, and removes them', async () => {
        const name = uniqueProject();
        const project = await registerProject();
        await service.create({ name });

        const first = await service.putProject(name, project, {
            codeRoot: '/opt/agent/TGA',
            worktreeRoot: '/opt/agent/wt',
            runRoot: '/opt/agent/run',
        });
        expect(first.projects).toEqual([{ project, codeRoot: '/opt/agent/TGA', worktreeRoot: '/opt/agent/wt', runRoot: '/opt/agent/run' }]);

        const second = await service.putProject(name, project, { codeRoot: '/opt/agent/TGA/', worktreeRoot: '/srv/wt/../wt2', runRoot: '/srv/run' });
        expect(second.projects).toEqual([{ project, codeRoot: '/opt/agent/TGA', worktreeRoot: '/srv/wt2', runRoot: '/srv/run' }]);

        await service.removeProject(name, project);
        expect((await service.get(name)).projects).toEqual([]);
        await expect(service.removeProject(name, project)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses a relative path, an unregistered project and an unknown host', async () => {
        const name = uniqueProject();
        const project = await registerProject();
        await service.create({ name });
        const paths = { codeRoot: '/a', worktreeRoot: '/b', runRoot: '/c' };

        await expect(service.putProject(name, project, { ...paths, codeRoot: 'relative' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.putProject(name, uniqueProject(), paths)).rejects.toMatchObject({ statusCode: 404 });
        await expect(service.putProject(uniqueProject(), project, paths)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('removes a host together with the projects it served', async () => {
        const name = uniqueProject();
        const project = await registerProject();
        await service.create({ name });
        await service.putProject(name, project, { codeRoot: '/a', worktreeRoot: '/b', runRoot: '/c' });

        await service.remove(name);

        await expect(service.get(name)).rejects.toMatchObject({ statusCode: 404 });
        expect(await db.selectFrom('wilson.hostProjects').selectAll().where('host', '=', name).execute()).toEqual([]);
        await expect(service.remove(name)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('reports the last probe once one is recorded, leaving out what it did not find', async () => {
        const name = uniqueProject();
        await service.create({ name });
        const probedAt = DateTime.fromISO('2026-10-29T12:00:00Z');
        const expiresAt = DateTime.fromISO('2026-10-30T00:00:00Z');

        await hosts.recordProbe(name, { probedAt, ok: true, engineVersion: '2.1.280', expiresAt });
        const probed = await service.get(name);
        expect(probed.probe?.ok).toBe(true);
        expect(probed.probe?.engineVersion).toBe('2.1.280');
        expect(probed.probe?.probedAt.toMillis()).toBe(probedAt.toMillis());
        expect(probed.probe?.expiresAt?.toMillis()).toBe(expiresAt.toMillis());
        expect(probed.probe).not.toHaveProperty('detail');

        await hosts.recordProbe(name, { probedAt, ok: false, detail: 'ssh: connect timed out' });
        const failed = await service.get(name);
        expect(failed.probe).toMatchObject({ ok: false, detail: 'ssh: connect timed out' });
        expect(failed.probe).not.toHaveProperty('expiresAt');
    });

    describe("a host's runs", () => {
        const event = async (project: string, cardId: string, stage: string, type: string, host?: string): Promise<void> => {
            await db
                .insertInto('wilson.cardEvents')
                .values({ project, cardId, stage, type, payload: JSON.stringify(host ? { host, slot: `host:${host}:slot:0` } : {}) })
                .execute();
        };

        it('says how each stage placed there ended, newest first', async () => {
            const name = uniqueProject();
            await service.create({ name });
            const project = await registerProject();
            const endings: Array<[string, string]> = [
                ['stage.passed', 'passed'],
                ['stage.failed', 'failed'],
                ['stage.poisoned', 'failed'],
                ['stage.dead', 'failed'],
                ['stage.host-lost', 'lost'],
                ['stage.interrupted', 'interrupted'],
                ['stage.stale', 'abandoned'],
            ];
            for (const [index, [type]] of endings.entries()) {
                const card = String(index).padStart(4, '0');
                await event(project, card, 'implementing', 'stage.placed', name);
                await event(project, card, 'implementing', 'tool.executed');
                await event(project, card, 'implementing', type);
            }

            const runs = await service.runs(name);

            expect(runs.map(run => [run.cardId, run.outcome])).toEqual(
                endings.map(([, outcome], index) => [String(index).padStart(4, '0'), outcome]).reverse(),
            );
            expect(runs.every(run => run.endedAt !== undefined && run.stage === 'implementing' && run.project === project)).toBe(true);
        });

        it('shows a stage still holding a slot as running, and one nothing more was said of as unknown', async () => {
            const name = uniqueProject();
            await service.create({ name });
            const project = await registerProject();
            await event(project, '0001', 'implementing', 'stage.placed', name);
            await event(project, '0002', 'implementing', 'stage.placed', name);
            await db.insertInto('wilson.cards').values({ project, id: '0002', title: 'Placed', stage: 'implementing', body: 'body' }).execute();
            await db
                .insertInto('wilson.leases')
                .values({ resourceKey: `host:${name}:slot:0`, project, cardId: '0002' })
                .execute();

            const runs = await service.runs(name);

            expect(runs.map(run => [run.cardId, run.outcome, run.endedAt])).toEqual([
                ['0002', 'running', undefined],
                ['0001', 'unknown', undefined],
            ]);
        });

        it("never takes a retry's ending for the attempt before it", async () => {
            const name = uniqueProject();
            await service.create({ name });
            const project = await registerProject();
            await event(project, '0001', 'implementing', 'stage.placed', name);
            await event(project, '0001', 'implementing', 'stage.placed', name);
            await event(project, '0001', 'implementing', 'stage.passed');

            expect((await service.runs(name)).map(run => run.outcome)).toEqual(['passed', 'unknown']);
        });

        it('leaves out other hosts and other stages of the card, and stops at twenty', async () => {
            const name = uniqueProject();
            const other = uniqueProject();
            await service.create({ name });
            await service.create({ name: other });
            const project = await registerProject();
            await event(project, '0001', 'implementing', 'stage.placed', other);
            await event(project, '0001', 'review', 'stage.passed');
            expect(await service.runs(name)).toEqual([]);
            expect((await service.runs(other)).map(run => run.outcome)).toEqual(['unknown']);

            for (let index = 0; index < 21; index++) await event(project, String(index).padStart(4, '0'), 'implementing', 'stage.placed', name);
            const runs = await service.runs(name);
            expect(runs).toHaveLength(20);
            expect(runs[0]?.cardId).toBe('0020');
        });

        it('refuses a host that is not registered', async () => {
            await expect(service.runs(uniqueProject())).rejects.toThrow();
        });
    });

    describe("a worker host's connection", () => {
        it('shows who is connected and since when, and stops once the worker has gone', async () => {
            const name = uniqueProject();
            await service.create({ name, kind: 'worker' });
            const server = await startWorkerServer({ token: (await hosts.find(name))! });
            const watching = new HostsService(hosts, projects, server.connections);
            try {
                expect(await watching.get(name)).not.toHaveProperty('connection');

                const before = DateTime.now();
                const worker = await FakeWorker.connect(server.url, 'token');
                await eventually(() => server.connections.get(name) !== undefined);

                const { connection } = await watching.get(name);
                expect(connection).toMatchObject({ workerVersion: '0.0.1-test', platform: 'linux' });
                expect(connection!.since.toMillis()).toBeGreaterThanOrEqual(before.toMillis());
                expect((await watching.list()).find(host => host.name === name)?.connection).toEqual(connection);

                worker.socket.close();
                await eventually(() => server.connections.get(name) === undefined);
                expect(await watching.get(name)).not.toHaveProperty('connection');
            } finally {
                await server.close();
            }
        });

        it('is absent on an SSH host', async () => {
            const name = uniqueProject();
            const server = await startWorkerServer({});
            try {
                const host = await new HostsService(hosts, projects, server.connections).create({ name });
                expect(host).not.toHaveProperty('connection');
            } finally {
                await server.close();
            }
        });
    });
});
