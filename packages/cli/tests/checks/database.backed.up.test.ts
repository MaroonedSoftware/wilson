import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Card 0262: the `backup` service (docker-compose.yml) writes nightly `pg_dump -Fc` archives to a
 * host directory; `database.backed.up.ts` is the doctor check that reads the same directory and
 * says when the newest one is missing, stale, or unreadable.
 *
 * `node:fs/promises` is exercised for real, against a real temp directory made with `mkdtemp` —
 * the check's own logic here (which file counts as "newest", the `wilson-YYYY-MM-DD.dump` name
 * filter that excludes an in-progress `.dump.tmp`, the age cutoff, the `PGDMP` header read) is
 * filesystem behaviour worth exercising directly rather than mocking away.
 *
 * `node:child_process`'s `execFile` is mocked, the same way `postgres.reachable.test.ts` mocks
 * `pg.Client` — these tests should not depend on `pg_restore` actually being on the host running
 * them, and need to control both "pg_restore says this archive is fine/bad" and "pg_restore isn't
 * installed at all" (the `ENOENT` fallback to the header check) independently of file content.
 */
const execFileMock = vi.fn((_file: string, _args: string[], callback: (err: unknown, stdout: string, stderr: string) => void) => {
    callback(new Error('execFileMock has no implementation configured for this call'), '', '');
});

vi.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args),
}));

const { databaseBackedUp } = await import('#src/checks/database.backed.up.js');

/** `pg_restore --list` reads the archive's table of contents fine. */
const pgRestoreSucceeds = () => execFileMock.mockImplementation((_f, _a, cb) => cb(null, '', ''));

/** `pg_restore` runs, but rejects the archive — present on the host, just says the file is bad. */
const pgRestoreRejects = () =>
    execFileMock.mockImplementation((_f, _a, cb) => cb(new Error('pg_restore: error: input file does not appear to be a valid archive'), '', ''));

/** `pg_restore` isn't on the host's `PATH` at all — the check should fall back to the header read. */
const pgRestoreMissing = () => execFileMock.mockImplementation((_f, _a, cb) => cb(Object.assign(new Error('spawn pg_restore ENOENT'), { code: 'ENOENT' }), '', ''));

/** A buffer of `totalBytes`, starting with the real `PGDMP` magic header, or something else entirely. */
const dumpBuffer = (totalBytes: number, validHeader = true): Buffer => {
    const buf = Buffer.alloc(totalBytes, 0);
    buf.write(validHeader ? 'PGDMP' : 'NOPE!', 0, 'ascii');
    return buf;
};

describe('databaseBackedUp', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'wilson-backup-test-'));
        execFileMock.mockReset();
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('is named "database backed up"', () => {
        expect(databaseBackedUp.name).toBe('database backed up');
    });

    it('passes and reports the newest dump’s age and size when it is recent and reads as a dump (AC1)', async () => {
        pgRestoreMissing();
        const name = 'wilson-2026-09-20.dump';
        await writeFile(join(dir, name), dumpBuffer(2048));
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(true);
        expect(result.message).toContain(name);
        expect(result.message).toContain('2.0 KB');
    });

    it('picks the newest dump’s name to report when more than one dump exists', async () => {
        pgRestoreMissing();
        const older = 'wilson-2026-09-01.dump';
        const newer = 'wilson-2026-09-20.dump';
        await writeFile(join(dir, older), dumpBuffer(64));
        await writeFile(join(dir, newer), dumpBuffer(64));
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        await utimes(join(dir, older), twoDaysAgo, twoDaysAgo);
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(true);
        expect(result.message).toContain(newer);
        expect(result.message).not.toContain(older);
    });

    it('fails, names the newest dump and its age, when it is older than 24 hours (AC2)', async () => {
        const name = 'wilson-2026-09-10.dump';
        const path = join(dir, name);
        await writeFile(path, dumpBuffer(64));
        const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
        await utimes(path, twentyFiveHoursAgo, twentyFiveHoursAgo);
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toContain(name);
        expect(result.message).toContain('older than 24h');
        // The age check short-circuits before this dump is ever inspected as an archive.
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('fails and names the resolved directory when it does not exist (AC3)', async () => {
        const missing = join(dir, 'does-not-exist');
        const ctx = { env: { WILSON_BACKUP_DIR: missing } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: `backup directory not found: ${missing}`,
            fixHint: 'Start the backup service (`docker compose up -d backup`), or check WILSON_BACKUP_DIR.',
        });
    });

    it('fails and names the resolved directory when it exists but holds no dump files (AC3)', async () => {
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`no dump files found in ${dir}`);
    });

    it('treats a still-being-written wilson-*.dump.tmp as no dump at all, not as the newest one', async () => {
        // The `backup` service writes to this name and renames on success (docker-compose.yml) —
        // an interrupted dump must never be mistaken for a good one.
        await writeFile(join(dir, 'wilson-2026-09-20.dump.tmp'), dumpBuffer(64));
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`no dump files found in ${dir}`);
    });

    it('fails and says so when the newest dump has no PGDMP header and pg_restore is not on the host (AC4)', async () => {
        pgRestoreMissing();
        const name = 'wilson-2026-09-20.dump';
        await writeFile(join(dir, name), dumpBuffer(64, false));
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`${name} does not read as a dump`);
    });

    it('fails when pg_restore --list itself rejects the archive, even with a well-formed header (AC4)', async () => {
        pgRestoreRejects();
        const name = 'wilson-2026-09-20.dump';
        await writeFile(join(dir, name), dumpBuffer(64, true));
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`${name} does not read as a dump`);
    });

    it('prefers pg_restore --list on the newest dump’s path over the header fallback', async () => {
        pgRestoreSucceeds();
        const name = 'wilson-2026-09-20.dump';
        const path = join(dir, name);
        // Not a valid PGDMP header — proves a pass here comes from pg_restore, not the header check.
        await writeFile(path, dumpBuffer(64, false));
        const ctx = { env: { WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(true);
        expect(execFileMock).toHaveBeenCalledWith('pg_restore', ['--list', path], expect.any(Function));
    });

    it('resolves WILSON_BACKUP_DIR from ctx.env through setting, relative to PROJECT_CODE_ROOT, never ctx.config (AC5)', async () => {
        // `ctx` below carries only `env` — no `config` at all — so a check that reached for
        // `ctx.config.get` would throw here rather than merely mis-resolve.
        const resolved = join(dir, 'relative-backups');
        const ctx = { env: { PROJECT_CODE_ROOT: dir, WILSON_BACKUP_DIR: 'relative-backups' } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: `backup directory not found: ${resolved}`,
            fixHint: expect.any(String),
        });
    });

    it('falls back to ../.wilson-backups relative to PROJECT_CODE_ROOT when WILSON_BACKUP_DIR is unset (AC5)', async () => {
        const root = join(dir, 'compose-dir');
        const resolved = join(root, '../.wilson-backups');
        const ctx = { env: { PROJECT_CODE_ROOT: root } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result).toEqual({
            ok: false,
            message: `backup directory not found: ${resolved}`,
            fixHint: expect.any(String),
        });
    });

    it('leaves an absolute WILSON_BACKUP_DIR untouched, ignoring PROJECT_CODE_ROOT (AC5)', async () => {
        const ctx = { env: { PROJECT_CODE_ROOT: '/somewhere/else', WILSON_BACKUP_DIR: dir } } as never;

        const result = await databaseBackedUp.run(ctx);

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`no dump files found in ${dir}`);
    });
});
