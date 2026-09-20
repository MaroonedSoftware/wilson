import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Check } from '@maroonedsoftware/johnny5';
import { DateTime } from 'luxon';
import { setting } from '../settings.js';

const exec = promisify(execFile);

// `wilson-YYYY-MM-DD.dump` only — the `backup` service (docker-compose.yml) writes to a
// `.dump.tmp` name and renames on success, so a dump interrupted halfway never matches this and
// is never mistaken for a good one.
const DUMP_NAME = /^wilson-\d{4}-\d{2}-\d{2}\.dump$/;

const MAX_AGE_HOURS = 24;

/**
 * The newest nightly dump must exist, be recent, and actually read as a dump.
 *
 * Card 0262, decision 1: Postgres is the system of record for the board, and durability is the
 * database's problem — but a problem nobody had built anything for. The compose stack had no dump
 * job and no volume backup; the markdown board it replaced was backed up only by the accident of
 * living in git. This check is the other half of the `backup` service in docker-compose.yml: that
 * service writes the dumps, this reads the same directory to say when the newest one is stale or
 * unreadable, so a broken nightly job is a red doctor check instead of a silent gap discovered at
 * restore time.
 *
 * Registered after `postgres reachable` (index.ts) — a database that is not reachable is a more
 * fundamental problem than its backups being stale.
 *
 * Reads only: this never writes, restores, or otherwise touches the dump it inspects.
 */
export const databaseBackedUp: Check = {
    name: 'database backed up',
    run: async ctx => {
        const dir = backupDir(ctx);

        const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
        if (!entries) {
            return {
                ok: false,
                message: `backup directory not found: ${dir}`,
                fixHint: `Start the backup service (\`docker compose up -d backup\`), or check WILSON_BACKUP_DIR.`,
            };
        }

        const dumpNames = entries.filter(e => e.isFile() && DUMP_NAME.test(e.name)).map(e => e.name);
        if (dumpNames.length === 0) {
            return {
                ok: false,
                message: `no dump files found in ${dir}`,
                fixHint: `Wait for the nightly backup (03:00 local), or check the \`backup\` service logs.`,
            };
        }

        const stats = await Promise.all(dumpNames.map(async name => ({ name, stat: await stat(join(dir, name)) })));
        const newest = stats.reduce((a, b) => (b.stat.mtimeMs > a.stat.mtimeMs ? b : a));
        const path = join(dir, newest.name);
        const ageHours = (Date.now() - newest.stat.mtimeMs) / (60 * 60 * 1000);
        const age = DateTime.fromMillis(newest.stat.mtimeMs).toRelative() ?? `${ageHours.toFixed(1)}h ago`;
        const size = formatBytes(newest.stat.size);

        if (ageHours > MAX_AGE_HOURS) {
            return {
                ok: false,
                message: `newest dump ${newest.name} is ${age} (older than ${MAX_AGE_HOURS}h)`,
                fixHint: `Check the \`backup\` service is running (\`docker compose ps backup\`) and its logs.`,
            };
        }

        if (!(await readsAsDump(path))) {
            return {
                ok: false,
                message: `${newest.name} does not read as a dump`,
                fixHint: `Inspect it by hand: \`pg_restore --list ${path}\`. It may have been interrupted or corrupted.`,
            };
        }

        return { ok: true, message: `${newest.name}, ${age}, ${size}` };
    },
};

/**
 * `WILSON_BACKUP_DIR` through `setting` (card 0247), never `ctx.config` — see settings.ts for why
 * `ctx.config` returns nothing regardless of `apps/api/.env`. Falls back to the same default the
 * compose file uses, `../.wilson-backups` relative to the compose file (`PROJECT_CODE_ROOT`, where
 * docker-compose.yml lives), and resolves a relative override the same way — relative to the
 * compose file rather than to whatever directory `wilson` happens to run from.
 */
function backupDir(ctx: Parameters<Check['run']>[0]): string {
    const root = setting(ctx, 'PROJECT_CODE_ROOT', '');
    const value = setting(ctx, 'WILSON_BACKUP_DIR', '../.wilson-backups');
    if (isAbsolute(value)) return value;
    return root ? join(root, value) : value;
}

/**
 * Prefers `pg_restore --list`, which reads a custom-format archive's table of contents without
 * connecting to any server or restoring anything. Falls back to checking the file's `PGDMP` magic
 * header when `pg_restore` isn't on the host — the host having Postgres client tools is not
 * guaranteed, only the `backup` service's own container does.
 */
async function readsAsDump(path: string): Promise<boolean> {
    try {
        await exec('pg_restore', ['--list', path]);
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return hasPgDumpHeader(path);
        return false;
    }
}

async function hasPgDumpHeader(path: string): Promise<boolean> {
    const handle = await open(path, 'r').catch(() => undefined);
    if (!handle) return false;
    try {
        const buf = Buffer.alloc(5);
        const { bytesRead } = await handle.read(buf, 0, 5, 0);
        return bytesRead === 5 && buf.toString('ascii') === 'PGDMP';
    } finally {
        await handle.close();
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}
