import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, sep } from 'node:path';
import { httpError } from '@maroonedsoftware/errors';
import type { DirectoryListing, DirectoryQuery } from '../../generated/projects.js';

/**
 * `GET /api/projects/directories`: one folder on the daemon's machine and the folders inside it, for
 * the web app's folder picker when registering a project. See `projects.ck` for why this exists and
 * why it is confined to one root.
 *
 * `root` is `PROJECT_BROWSE_ROOT` in production, or the daemon user's home folder without one
 * (`BoardModule`); tests pass a temporary folder. Both `root` and every requested path are resolved
 * with `realpath` before the containment check, so neither `..` segments nor a symlink pointing out
 * of the root can list anything outside it. The listing reports the resolved path, which is also
 * what the picker then fills in.
 */
export class ProjectDirectoriesService {
    constructor(readonly root: string) {}

    async list(query: DirectoryQuery): Promise<DirectoryListing> {
        const root = await realpath(this.root);
        const requested = query.path ?? root;
        if (!isAbsolute(requested)) {
            throw httpError(400).withDetails({ reason: `path must be absolute, got "${requested}"` });
        }

        const path = await resolveExisting(requested);
        if (path !== root && !path.startsWith(root + sep)) {
            throw httpError(403).withDetails({ reason: `"${requested}" is outside ${root}, the only folder this lists` });
        }
        if (!(await stat(path)).isDirectory()) {
            throw httpError(400).withDetails({ reason: `"${requested}" is not a folder` });
        }

        const entries = await readdir(path, { withFileTypes: true }).catch((err: unknown) => {
            if (errorCode(err) === 'EACCES' || errorCode(err) === 'EPERM') {
                throw httpError(403).withDetails({ reason: `cannot read "${path}"` });
            }
            throw err;
        });
        const directories = entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));

        return { path, parent: path === root ? undefined : dirname(path), directories };
    }
}

/** `realpath`, with a missing path mapped to 404 rather than surfacing as a 500. */
async function resolveExisting(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (err) {
        if (errorCode(err) === 'ENOENT') throw httpError(404).withDetails({ reason: `nothing exists at "${path}"` });
        if (errorCode(err) === 'ENOTDIR') throw httpError(400).withDetails({ reason: `"${path}" is not a folder` });
        if (errorCode(err) === 'EACCES' || errorCode(err) === 'EPERM') throw httpError(403).withDetails({ reason: `cannot read "${path}"` });
        throw err;
    }
}

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;
