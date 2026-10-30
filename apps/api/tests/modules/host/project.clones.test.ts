import { describe, expect, it, vi } from 'vitest';
import type { ProjectRepository } from '#modules/board/project.repository.js';
import type { GitHubApp } from '#modules/github/github.app.js';
import type { ExecutionHost } from '#modules/host/execution.host.js';
import { ProjectClones } from '#modules/host/project.clones.js';

const clones = (repository?: string) =>
    new ProjectClones(
        { find: async () => ({ repository }) } as unknown as ProjectRepository,
        { tokenFor: vi.fn(async () => 'short-lived') } as unknown as GitHubApp,
    );

const host = (isClone: boolean) =>
    ({
        exec: vi.fn(async () => {
            if (!isClone) throw new Error('not a git repository');
            return { stdout: '.git\n', stderr: '' };
        }),
        cloneRepository: vi.fn(async () => undefined),
    }) as unknown as ExecutionHost & { cloneRepository: ReturnType<typeof vi.fn> };

describe('ProjectClones', () => {
    it('leaves a clone already there alone', async () => {
        const target = host(true);

        await clones('acme/widgets').ensure(target, 'widgets', '/srv/wilson/widgets/code');

        expect(target.cloneRepository).not.toHaveBeenCalled();
    });

    it('clones a missing project from its GitHub repository, with a token for it', async () => {
        const target = host(false);

        await clones('acme/widgets').ensure(target, 'widgets', '/srv/wilson/widgets/code');

        expect(target.cloneRepository).toHaveBeenCalledWith('https://github.com/acme/widgets.git', '/srv/wilson/widgets/code', 'short-lived');
    });

    it('refuses, saying why, when the project has no repository to clone', async () => {
        await expect(clones().ensure(host(false), 'widgets', '/srv/wilson/widgets/code')).rejects.toThrow('has no GitHub repository');
    });

    it('does nothing on a host that cannot make its own clones', async () => {
        const target = { exec: vi.fn() } as unknown as ExecutionHost;

        await clones('acme/widgets').ensure(target, 'widgets', '/srv/wilson/widgets/code');

        expect(target.exec).not.toHaveBeenCalled();
    });
});
