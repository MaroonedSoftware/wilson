/* eslint-disable turbo/no-undeclared-env-vars -- these tests set the environment the stand-in ssh hands its "remote" shell; nothing here is a build input */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { HostConnector } from '#modules/host/host.connector.js';
import { HostProber } from '#modules/host/host.prober.js';
import { HostRepository } from '#modules/host/host.repository.js';
import { HostsService } from '#modules/host/hosts.service.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);

/**
 * The probe against the stand-in `ssh` (`tests/support/fake.ssh.sh`), so each check runs for real on
 * this machine as if it were the host. A stub `claude` is put first on `PATH` for the "host" to find,
 * since the real one may or may not be installed where the suite runs.
 */
const FAKE_SSH = fileURLToPath(new URL('../../support/fake.ssh.sh', import.meta.url));

/** The boot time the stub `sysctl` reports, in seconds since the epoch. */
const BOOT_SECONDS = 1_793_260_800;

let db: Kysely<DB>;
let hosts: HostRepository;
let service: HostsService;
let base: string;
let originalPath: string | undefined;

beforeAll(async () => {
    db = testDb();
    hosts = new HostRepository(db);
    service = new HostsService(hosts, new ProjectRepository(db));

    base = await mkdtemp(join(tmpdir(), 'host-prober-'));
    const bin = join(base, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', 'utf8');
    await chmod(join(bin, 'claude'), 0o755);
    // BSD's format, which a machine without /proc/stat falls back to. A stub rather than the real one:
    // its answer is fixed, so the expiry can be checked exactly, and a sandboxed run may not be
    // allowed to call the real `sysctl` at all.
    await writeFile(join(bin, 'sysctl'), `#!/bin/sh\necho "{ sec = ${BOOT_SECONDS}, usec = 961842 } Thu Oct 29 08:00:00 2026"\n`, 'utf8');
    await chmod(join(bin, 'sysctl'), 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;

    await mkdir(join(base, 'clone'));
    await exec('git', ['init', '-q', join(base, 'clone')]);
});

afterAll(async () => {
    process.env.PATH = originalPath;
    await db.destroy();
});

const registerHost = async (paths: { codeRoot: string }, lifetimeMinutes?: number): Promise<string> => {
    const project = uniqueProject();
    await new ProjectRepository(db).create({ name: project, codeRoot: '/tmp/code', worktreeRoot: '/tmp/wt', runRoot: '/tmp/run' });
    const name = uniqueProject();
    await service.create({ name, ...(lifetimeMinutes && { lifetimeMinutes }) });
    await service.putProject(name, project, { codeRoot: paths.codeRoot, worktreeRoot: join(base, name, 'wt'), runRoot: join(base, name, 'run') });
    return name;
};

describe('HostProber', () => {
    const prober = () => new HostProber(hosts, new HostConnector(FAKE_SSH));

    it('records a healthy host: its claude version, a note that it is unprobed, and when it expires', async () => {
        const name = await registerHost({ codeRoot: join(base, 'clone') }, 720);

        const host = await prober().probe(name);

        expect(host.probe?.ok).toBe(true);
        expect(host.probe?.engineVersion).toBe('9.9.9');
        expect(host.probe?.detail).toContain('claude 9.9.9 has not been through the engine probes');
        if (existsSync('/proc/stat')) {
            // Linux reads its real boot time first and never reaches the stub: in the past, so a
            // 12-hour lifetime ends no later than 12 hours from now.
            expect(host.probe?.expiresAt?.toMillis()).toBeLessThanOrEqual(DateTime.now().plus({ minutes: 720 }).toMillis());
        } else {
            expect(host.probe?.expiresAt?.toMillis()).toBe(DateTime.fromSeconds(BOOT_SECONDS).plus({ minutes: 720 }).toMillis());
        }
    });

    it('reports a clone that is not a git repository, and still runs every other check', async () => {
        const name = await registerHost({ codeRoot: join(base, 'not-a-repo') });

        const host = await prober().probe(name);

        expect(host.probe?.ok).toBe(false);
        expect(host.probe?.detail).toContain('is not a git repository');
        expect(host.probe?.engineVersion).toBe('9.9.9');
        expect(host.probe).not.toHaveProperty('expiresAt');
    });

    it('records an unreachable host as a failed probe, not an error', async () => {
        const name = await registerHost({ codeRoot: join(base, 'clone') });
        const unreachable = join(base, 'unreachable-ssh');
        await writeFile(unreachable, '#!/bin/sh\necho "ssh: connect to host agent-9 port 22: Operation timed out" >&2\nexit 255\n', 'utf8');
        await chmod(unreachable, 0o755);

        const host = await new HostProber(hosts, new HostConnector(unreachable)).probe(name);

        expect(host.probe?.ok).toBe(false);
        expect(host.probe?.detail).toMatch(/^cannot reach .*Operation timed out/);
    });

    it('reports a variable the host says it supplies to commands but does not have', async () => {
        const name = await registerHost({ codeRoot: join(base, 'clone') });
        await service.update(name, { commandEnv: ['WILSON_PROBE_SET', 'WILSON_PROBE_MISSING'] });
        process.env.WILSON_PROBE_SET = 'yes';
        try {
            const host = await prober().probe(name);

            expect(host.probe?.ok).toBe(false);
            expect(host.probe?.detail).toContain('WILSON_PROBE_MISSING is not set in its environment');
            expect(host.probe?.detail).not.toContain('WILSON_PROBE_SET is not set');
        } finally {
            delete process.env.WILSON_PROBE_SET;
        }
    });

    it('refuses an unknown host with 404 and a disabled one with 409, recording nothing', async () => {
        await expect(prober().probe(uniqueProject())).rejects.toMatchObject({ statusCode: 404 });

        const name = await registerHost({ codeRoot: join(base, 'clone') });
        await service.update(name, { enabled: false });
        await expect(prober().probe(name)).rejects.toMatchObject({ statusCode: 409 });
        expect((await service.get(name)).probe).toBeUndefined();
    });
});
