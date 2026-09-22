import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDirectoriesService } from '#modules/board/project.directories.service.js';

/**
 * `GET /api/projects/directories`'s service against a real temporary folder standing in for the
 * home folder. The layout is built fresh per test:
 *
 *     <sandbox>/home/          the root the service is confined to
 *         projects/alpha/      a folder
 *         projects/beta/       a folder
 *         projects/notes.txt   a file, never listed
 *         projects/.hidden/    a dotfolder, listed (hiding it is the picker's job)
 *         escape -> <sandbox>/outside
 *     <sandbox>/outside/secret/
 */
describe('ProjectDirectoriesService', () => {
    let sandbox: string;
    let home: string;
    let service: ProjectDirectoriesService;

    beforeEach(async () => {
        // `realpath` because macOS's tmpdir is itself a symlink (/var -> /private/var), and the
        // service reports resolved paths.
        sandbox = await realpath(await mkdtemp(join(tmpdir(), 'wilson-dirs-')));
        home = join(sandbox, 'home');
        await mkdir(join(home, 'projects', 'beta'), { recursive: true });
        await mkdir(join(home, 'projects', 'alpha'));
        await mkdir(join(home, 'projects', '.hidden'));
        await writeFile(join(home, 'projects', 'notes.txt'), '');
        await mkdir(join(sandbox, 'outside', 'secret'), { recursive: true });
        await symlink(join(sandbox, 'outside'), join(home, 'escape'));
        service = new ProjectDirectoriesService(home);
    });

    afterEach(async () => {
        await rm(sandbox, { recursive: true, force: true });
    });

    it('lists the home folder when no path is given, with no parent to go up to', async () => {
        const listing = await service.list({});

        expect(listing.path).toBe(home);
        expect(listing.parent).toBeUndefined();
        expect(listing.directories).toContain('projects');
    });

    it('lists only the folders inside a path, sorted, with hidden folders included and files left out', async () => {
        const listing = await service.list({ path: join(home, 'projects') });

        expect(listing).toEqual({ path: join(home, 'projects'), parent: home, directories: ['.hidden', 'alpha', 'beta'] });
    });

    it('reports the resolved path, so a trailing slash or a `..` inside the root comes back clean', async () => {
        const listing = await service.list({ path: `${home}/projects/alpha/../beta/` });

        expect(listing.path).toBe(join(home, 'projects', 'beta'));
    });

    it('refuses a relative path with 400', async () => {
        await expect(service.list({ path: 'projects' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('absolute') },
        });
    });

    it('refuses a path outside the home folder with 403, including one reached through `..`', async () => {
        await expect(service.list({ path: join(sandbox, 'outside') })).rejects.toMatchObject({ statusCode: 403 });
        await expect(service.list({ path: `${home}/..` })).rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses a symlink inside the home folder that points out of it', async () => {
        await expect(service.list({ path: join(home, 'escape', 'secret') })).rejects.toMatchObject({ statusCode: 403 });
    });

    it('does not list a symlink that points out of the home folder as a folder to open', async () => {
        const listing = await service.list({});

        expect(listing.directories).not.toContain('escape');
    });

    it('refuses a missing path with 404', async () => {
        await expect(service.list({ path: join(home, 'nope') })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses a file with 400', async () => {
        await expect(service.list({ path: join(home, 'projects', 'notes.txt') })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('not a folder') },
        });
    });
});
