import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { HostRepository } from '#modules/host/host.repository.js';
import { HostsService } from '#modules/host/hosts.service.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * The host registry, against a real connection for the reason `project.repository.test.ts` gives:
 * a fake would only prove the test agrees with itself about what a write means. Host names come
 * from `uniqueProject()` too, since `runner.hosts` is deployment-scoped and shared by every test.
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
    it('registers a host with its SSH target defaulting to its name and one slot', async () => {
        const name = uniqueProject();

        const host = await service.create({ name });

        expect(host).toEqual({ name, sshTarget: name, slots: 1, enabled: true, draining: false, projects: [] });
        expect(await service.list()).toContainEqual(host);
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

        const moved = await service.update(name, { sshTarget: 'agent-2', enabled: false });
        expect(moved).toMatchObject({ sshTarget: 'agent-2', slots: 2, enabled: false, draining: true });

        expect(await service.update(name, {})).toEqual(moved);
        await expect(service.update(uniqueProject(), { slots: 1 })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('records a lifetime, clears it with 0, and refuses a negative one', async () => {
        const name = uniqueProject();

        expect(await service.create({ name, lifetimeMinutes: 720 })).toMatchObject({ lifetimeMinutes: 720 });
        expect(await service.update(name, { lifetimeMinutes: 0 })).not.toHaveProperty('lifetimeMinutes');
        await expect(service.update(name, { lifetimeMinutes: -5 })).rejects.toMatchObject({ statusCode: 400 });
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
        expect(await db.selectFrom('runner.hostProjects').selectAll().where('host', '=', name).execute()).toEqual([]);
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
});
