import { describe, expect, it, vi } from 'vitest';
import { ProjectRepositoriesService } from '#modules/board/project.repositories.service.js';
import type { GitHubApp } from '#modules/github/github.app.js';

describe('ProjectRepositoriesService', () => {
    it('answers with what the app can read', async () => {
        const repository = { fullName: 'acme/app', private: true, defaultBranch: 'main' };
        const app = { configured: true, repositories: async () => [repository] } as unknown as GitHubApp;

        expect(await new ProjectRepositoriesService(app).list()).toEqual({ configured: true, repositories: [repository] });
    });

    it('says no app is configured rather than failing, and asks GitHub nothing', async () => {
        const repositories = vi.fn();
        const app = { configured: false, repositories } as unknown as GitHubApp;

        expect(await new ProjectRepositoriesService(app).list()).toEqual({ configured: false, repositories: [] });
        expect(repositories).not.toHaveBeenCalled();
    });
});
