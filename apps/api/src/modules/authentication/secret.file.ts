import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where generated secrets live when config does not supply them: a sibling of the code repo,
 * outside it, the way `WILSON_BACKUP_DIR` defaults to `../.wilson-backups`. Outside the repo so a
 * secret can never be committed, and outside `PROJECT_RUN_ROOT` because plans are materialized
 * there for agents to read.
 */
export const SECRETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../.wilson-secrets');

/**
 * The contents of `file`, generating them with `create` and writing them owner-only when the file
 * does not exist yet, as deadair's container generates its keys on first boot.
 *
 * `wx`: if two processes generate at once (the daemon and a CLI command booting together), the
 * second write fails rather than replacing a secret the first may already have used, and the
 * second reads what the first wrote.
 *
 * Owner-only keeps the file from other users on the host, not from a stage: project code a stage
 * runs is this same user (PROJECT.md, Authentication: What this does not cover).
 */
export const readOrCreateSecretFile = async (file: string, create: () => string): Promise<string> => {
    const existing = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
    });
    if (existing !== undefined) return existing;

    const secret = create();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
        await writeFile(file, secret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        return readFile(file, 'utf8');
    }
    await chmod(file, 0o600);
    return secret;
};
