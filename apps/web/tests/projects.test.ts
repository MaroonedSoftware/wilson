// Card 0154: `listRegisteredProjects` (`apps/web/src/lib/projects.ts`) delegates to the generated
// `ProjectsClient` (`@wilson/sdk`, backed by `apps/api/data/contracts/projects.ck`, card 0162) through
// the unscoped `wilson` singleton — not a hand-written `fetch` against `GET /api/projects` as an
// earlier version of this file argued. These tests drive it the same way `sdk.test.ts` and
// `project-switcher.test.ts` exercise other SDK-backed calls: stubbing `ProjectsClient.prototype`
// rather than `fetch`, so the assertion tracks "did this call the generated client" and not the
// client's own internal transport.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectsClient } from '@wilson/sdk';
import type { Project } from '@wilson/sdk';
import { defaultProjectPaths, listRegisteredProjects } from '#src/lib/projects.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('listRegisteredProjects', () => {
    it('resolves to exactly the registered projects the generated client returns', async () => {
        const projects: Project[] = [{ name: 'alpha' }, { name: 'beta' }];
        vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue(projects);

        await expect(listRegisteredProjects()).resolves.toEqual(projects);
    });

    it('calls the generated ProjectsClient exactly once, taking no arguments of its own', async () => {
        const listProjects = vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue([]);

        await listRegisteredProjects();

        expect(listProjects).toHaveBeenCalledTimes(1);
        expect(listProjects).toHaveBeenCalledWith();
    });

    it('propagates a rejection from the client rather than swallowing it', async () => {
        vi.spyOn(ProjectsClient.prototype, 'listProjects').mockRejectedValue(new Error('500 Internal Server Error'));

        await expect(listRegisteredProjects()).rejects.toThrow(/500/);
    });
});

describe('defaultProjectPaths', () => {
    it('puts a per-project worktree and run root beside the repo, in the directory that holds it', () => {
        expect(defaultProjectPaths('myapp', '/srv/projects/myapp')).toEqual({
            worktreeRoot: '/srv/projects/.worktrees/myapp',
            runRoot: '/srv/projects/.run/myapp',
        });
    });

    it('ignores trailing slashes and surrounding whitespace', () => {
        expect(defaultProjectPaths(' myapp ', ' /srv/projects/myapp// ')).toEqual({
            worktreeRoot: '/srv/projects/.worktrees/myapp',
            runRoot: '/srv/projects/.run/myapp',
        });
    });

    it('proposes nothing without a name or an absolute code root', () => {
        const empty = { worktreeRoot: '', runRoot: '' };
        expect(defaultProjectPaths('', '/srv/projects/myapp')).toEqual(empty);
        expect(defaultProjectPaths('myapp', 'projects/myapp')).toEqual(empty);
        expect(defaultProjectPaths('myapp', '')).toEqual(empty);
    });
});
