import { describe, expect, it } from 'vitest';
import { ProjectsService } from '#modules/board/projects.service.js';
import type { ProjectRepository, ProjectRow } from '#modules/board/project.repository.js';

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
        boardRoot: `/board/${name}`,
        codeRoot: `/code/${name}`,
        worktreeRoot: `/wt/${name}`,
        runRoot: `/run/${name}`,
    });

    it('maps every registered project row down to its name, in the order the repository returned them', async () => {
        const rows = [row('alpha'), row('beta')];
        const repository = { list: async () => rows } as unknown as ProjectRepository;
        const service = new ProjectsService(repository);

        const result = await service.list();

        expect(result).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
    });

    // The contract withholds `boardRoot`/`codeRoot`/`worktreeRoot`/`runRoot` deliberately (see
    // projects.ck's own comment) — an unauthenticated surface (card 0019) should return the minimum
    // that serves a project switcher, not everything `ProjectRepository.list()` happens to read.
    // `toEqual` above already pins the exact shape, but this asserts the withholding directly so a
    // future change that widens the mapped object (e.g. `{ ...row }` instead of `{ name: row.name }`)
    // fails here even if it still satisfies a looser shape check elsewhere.
    it('carries no path field from the repository row — only name', async () => {
        const repository = { list: async () => [row('alpha')] } as unknown as ProjectRepository;
        const service = new ProjectsService(repository);

        const [project] = await service.list();

        expect(Object.keys(project!)).toEqual(['name']);
        expect(project).not.toHaveProperty('boardRoot');
        expect(project).not.toHaveProperty('codeRoot');
        expect(project).not.toHaveProperty('worktreeRoot');
        expect(project).not.toHaveProperty('runRoot');
    });

    it('returns an empty array when no project is registered, rather than throwing or returning undefined', async () => {
        const repository = { list: async () => [] } as unknown as ProjectRepository;
        const service = new ProjectsService(repository);

        await expect(service.list()).resolves.toEqual([]);
    });
});
