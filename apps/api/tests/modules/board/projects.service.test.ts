import { describe, expect, it } from 'vitest';
import { ProjectsService } from '#modules/board/projects.service.js';
import type { ProjectDirectoriesService } from '#modules/board/project.directories.service.js';
import type { ProjectRepository, ProjectRow } from '#modules/board/project.repository.js';
import type { GitHubCloner } from '#modules/github/github.cloner.js';

/**
 * Card 0162. `ProjectsService` is the service `GET /api/projects` (projects.ck) binds to — a thin
 * read surface over `ProjectRepository.list()` that maps each row down to its `name` alone. Like
 * `BoardService`'s own tests, this hands the service a hand-rolled fake for its one collaborator
 * rather than a real `ProjectRepository`, since `ProjectRepository.list()` already has its own
 * Postgres-backed coverage (`project.repository.test.ts`).
 */
describe('ProjectsService', () => {
    const row = (name: string): ProjectRow => ({
        name,
        codeRoot: `/code/${name}`,
        worktreeRoot: `/wt/${name}`,
        runRoot: `/run/${name}`,
    });

    // Only a request naming a `repository` reaches the directories or the cloner, and none of these does.
    const serviceOver = (repository: ProjectRepository) => new ProjectsService(repository, {} as ProjectDirectoriesService, {} as GitHubCloner);

    it('maps every registered project row down to its name, in the order the repository returned them', async () => {
        const rows = [row('alpha'), row('beta')];
        const repository = { list: async () => rows } as unknown as ProjectRepository;
        const service = serviceOver(repository);

        const result = await service.list();

        expect(result).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
    });

    // The contract withholds `codeRoot`/`worktreeRoot`/`runRoot` deliberately (see
    // projects.ck's own comment) — an unauthenticated surface (card 0019) should return the minimum
    // that serves a project switcher, not everything `ProjectRepository.list()` happens to read.
    // `toEqual` above already pins the exact shape, but this asserts the withholding directly so a
    // future change that widens the mapped object (e.g. `{ ...row }` instead of `{ name: row.name }`)
    // fails here even if it still satisfies a looser shape check elsewhere.
    it('carries no path field from the repository row — only name', async () => {
        const repository = { list: async () => [row('alpha')] } as unknown as ProjectRepository;
        const service = serviceOver(repository);

        const [project] = await service.list();

        expect(Object.keys(project!)).toEqual(['name']);
        expect(project).not.toHaveProperty('codeRoot');
        expect(project).not.toHaveProperty('worktreeRoot');
        expect(project).not.toHaveProperty('runRoot');
    });

    it('returns an empty array when no project is registered, rather than throwing or returning undefined', async () => {
        const repository = { list: async () => [] } as unknown as ProjectRepository;
        const service = serviceOver(repository);

        await expect(service.list()).resolves.toEqual([]);
    });

    /**
     * Card 0168. `create` is `POST /api/projects`'s service — the write half of the registry, beside
     * the read `list` already covers above. Fake `find`/`create` collaborators, the same reasoning
     * this file's header gives for `list`'s own tests.
     */
    describe('create (card 0168)', () => {
        const request = (overrides: Partial<{ name: string; codeRoot: string; worktreeRoot: string; runRoot: string }> = {}) => ({
            name: 'wilson',
            codeRoot: '/code',
            worktreeRoot: '/wt',
            runRoot: '/run',
            ...overrides,
        });

        it('creates the row with every path resolved, and answers with the name alone', async () => {
            const created: ProjectRow[] = [];
            const repository = {
                find: async () => undefined,
                create: async (row: ProjectRow) => {
                    created.push(row);
                },
            } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            const result = await service.create(request());

            expect(result).toEqual({ name: 'wilson' });
            expect(created).toEqual([{ name: 'wilson', codeRoot: '/code', worktreeRoot: '/wt', runRoot: '/run' }]);
        });

        // Stored paths are resolve()d, so `/a/b/../c` and `/a/c` register identically — the same
        // normalisation `BoardModule` already applies to the environment-seeded row.
        it('normalises every path with resolve(), so a relative segment inside an absolute path collapses', async () => {
            const created: ProjectRow[] = [];
            const repository = {
                find: async () => undefined,
                create: async (row: ProjectRow) => {
                    created.push(row);
                },
            } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            await service.create(request({ codeRoot: '/a/b/../c' }));

            expect(created[0]?.codeRoot).toBe('/a/c');
        });

        it('refuses an already-registered name with 409, and never calls create', async () => {
            const create = async () => {
                throw new Error('create should not have been called');
            };
            const repository = { find: async () => ({ name: 'wilson', codeRoot: '/x', worktreeRoot: '/x', runRoot: '/x' }), create } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            await expect(service.create(request())).rejects.toMatchObject({
                statusCode: 409,
                details: { reason: expect.stringContaining('wilson') },
            });
        });

        it.each(['codeRoot', 'worktreeRoot', 'runRoot'])(
            'refuses a relative %s with 400, and never checks for a duplicate name or writes a row',
            async field => {
                const find = async () => {
                    throw new Error('find should not have been called — path validation runs first');
                };
                const create = async () => {
                    throw new Error('create should not have been called');
                };
                const repository = { find, create } as unknown as ProjectRepository;
                const service = serviceOver(repository);

                await expect(service.create(request({ [field]: 'relative/path' }))).rejects.toMatchObject({
                    statusCode: 400,
                    details: { reason: expect.stringContaining(field) },
                });
            },
        );

        it('refuses an empty path with 400', async () => {
            const repository = {
                find: async () => {
                    throw new Error('find should not have been called');
                },
                create: async () => {
                    throw new Error('create should not have been called');
                },
            } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            await expect(service.create(request({ codeRoot: '' }))).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    /**
     * Card 0168. `update` is `PATCH /api/projects/{name}`'s service — a partial update of the three
     * path columns for one already-registered name.
     */
    describe('update (card 0168)', () => {
        it('passes through only the fields present in the request, and answers with the name alone', async () => {
            const patches: Array<Partial<ProjectRow>> = [];
            const repository = {
                update: async (name: string, patch: Partial<ProjectRow>) => {
                    patches.push({ name: name as never, ...patch });
                    return true;
                },
            } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            const result = await service.update('wilson', { codeRoot: '/new-code' });

            expect(result).toEqual({ name: 'wilson' });
            expect(patches).toEqual([{ name: 'wilson', codeRoot: '/new-code' }]);
        });

        it('leaves fields absent from the request out of the patch entirely, rather than sending them as undefined overwrites', async () => {
            const patches: Array<Partial<ProjectRow>> = [];
            const repository = {
                update: async (_name: string, patch: Partial<ProjectRow>) => {
                    patches.push(patch);
                    return true;
                },
            } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            await service.update('wilson', { runRoot: '/new-run' });

            expect(Object.keys(patches[0]!)).toEqual(['runRoot']);
        });

        it('normalises a present path with resolve() before handing it to the repository', async () => {
            const patches: Array<Partial<ProjectRow>> = [];
            const repository = {
                update: async (_name: string, patch: Partial<ProjectRow>) => {
                    patches.push(patch);
                    return true;
                },
            } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            await service.update('wilson', { codeRoot: '/a/b/../c' });

            expect(patches[0]?.codeRoot).toBe('/a/c');
        });

        it('refuses a present but relative path with 400, and never calls the repository', async () => {
            const update = async () => {
                throw new Error('update should not have been called');
            };
            const repository = { update } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            await expect(service.update('wilson', { codeRoot: 'relative/path' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('codeRoot') },
            });
        });

        it('refuses an unregistered name with 404 when the repository reports no row matched', async () => {
            const repository = { update: async () => false } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            await expect(service.update('ghost', { codeRoot: '/new-code' })).rejects.toMatchObject({
                statusCode: 404,
                details: { reason: expect.stringContaining('ghost') },
            });
        });

        it('carries no path field in its response — only name, the same withholding "create" and "list" both give', async () => {
            const repository = { update: async () => true } as unknown as ProjectRepository;
            const service = serviceOver(repository);

            const result = await service.update('wilson', { codeRoot: '/new-code' });

            expect(Object.keys(result)).toEqual(['name']);
        });
    });

    describe('repository', () => {
        const fake = () => {
            const created: ProjectRow[] = [];
            const patches: unknown[] = [];
            const repository = {
                find: async () => undefined,
                create: async (row: ProjectRow) => void created.push(row),
                update: async (_: string, patch: unknown) => (patches.push(patch), true),
            } as unknown as ProjectRepository;
            const cloned: [string, string][] = [];
            const cloner = { clone: async (repo: string, target: string) => void cloned.push([repo, target]) } as unknown as GitHubCloner;
            const directories = { root: '/projects' } as ProjectDirectoriesService;
            return { service: new ProjectsService(repository, directories, cloner), created, patches, cloned };
        };
        const paths = { codeRoot: '/code/a', worktreeRoot: '/wt/a', runRoot: '/run/a' };

        it('keeps the repository a project is registered with', async () => {
            const { service, created } = fake();

            await service.create({ name: 'a', ...paths, repository: 'acme/app' });

            expect(created[0]?.repository).toBe('acme/app');
        });

        it('clones to the path it was given', async () => {
            const { service, cloned } = fake();

            await service.create({ name: 'a', ...paths, repository: 'acme/app' });

            expect(cloned).toEqual([['acme/app', '/code/a']]);
        });

        it('derives every path it is not given from the repository, not the free-text name', async () => {
            const { service, created, cloned } = fake();

            await service.create({ name: 'Toku ATS', repository: 'acme/toku-ats' });

            expect(created[0]).toEqual({
                name: 'Toku ATS',
                codeRoot: '/projects/toku-ats',
                worktreeRoot: '/projects/.worktrees/toku-ats',
                runRoot: '/projects/.run/toku-ats',
                repository: 'acme/toku-ats',
            });
            expect(cloned).toEqual([['acme/toku-ats', '/projects/toku-ats']]);
        });

        it('registers nothing when the clone fails', async () => {
            const created: ProjectRow[] = [];
            const failing = new ProjectsService(
                { find: async () => undefined, create: async (row: ProjectRow) => void created.push(row) } as unknown as ProjectRepository,
                { root: '/projects' } as ProjectDirectoriesService,
                { clone: async () => Promise.reject(new Error('no')) } as unknown as GitHubCloner,
            );

            await expect(failing.create({ name: 'a', repository: 'acme/app' })).rejects.toThrow('no');
            expect(created).toEqual([]);
        });

        it('still requires every path without a repository', async () => {
            const { service } = fake();

            await expect(service.create({ name: 'a' })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('sets a repository on a registered project, cloning nothing', async () => {
            const { service, patches, cloned } = fake();

            await service.update('a', { repository: 'acme/app' });

            expect(patches).toEqual([{ repository: 'acme/app' }]);
            expect(cloned).toEqual([]);
        });

        it.each(['app', 'acme/app/extra', 'https://github.com/acme/app', '../app'])('refuses "%s", which is not owner/name', async value => {
            const { service, created } = fake();

            await expect(service.create({ name: 'a', ...paths, repository: value })).rejects.toMatchObject({ statusCode: 400 });
            expect(created).toEqual([]);
        });
    });
});
