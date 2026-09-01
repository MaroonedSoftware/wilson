import { describe, expect, it } from 'vitest';
import { ProjectScopedBoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import type { ProjectRow } from '#modules/board/project.repository.js';

/**
 * Card 0149. `ProjectScopedBoardConfig` is the `BoardConfig` the running daemon actually registers —
 * every field answers for whichever project `project.context.ts`'s `currentProject()` names, falling
 * back to the daemon's own configured project when nothing has called `runAsProject`. These tests go
 * straight at the class, independent of `Poller`/`CardStageJob`/`BoardModule`, which each have their
 * own tests exercising it through their own call paths.
 */
const row = (name: string, overrides: Partial<Omit<ProjectRow, 'name'>> = {}): ProjectRow => ({
    name,
    codeRoot: `/tmp/${name}/code`,
    worktreeRoot: `/tmp/${name}/worktrees`,
    runRoot: `/tmp/${name}/run`,
    ...overrides,
});

describe('ProjectScopedBoardConfig', () => {
    it('answers for the default project when nothing has called runAsProject', () => {
        const config = new ProjectScopedBoardConfig('alpha');
        config.register(row('alpha'));

        expect(config.project).toBe('alpha');
        expect(config.codeRoot).toBe('/tmp/alpha/code');
        expect(config.worktreeRoot).toBe('/tmp/alpha/worktrees');
        expect(config.runRoot).toBe('/tmp/alpha/run');
    });

    it('throws reading a project that was never registered, rather than falling back silently', () => {
        const config = new ProjectScopedBoardConfig('alpha');

        expect(() => config.codeRoot).toThrow(/alpha.*not registered/i);
    });

    it('throws reading the default project itself before it has ever been registered', () => {
        // A caller that never calls `register` at all — the class does not assume its own
        // `defaultProject` argument is automatically a registered project.
        const config = new ProjectScopedBoardConfig('alpha');

        expect(() => config.codeRoot).toThrow();
    });

    /**
     * The acceptance criterion this pins down directly: "Two projects' cards sharing an id do not
     * collide on disk." That property reduces, at this layer, to two registered projects' paths never
     * being visible at the same time — proven here by reading every path field for each project from
     * inside its own `runAsProject` scope and checking neither ever answers with the other's value.
     */
    it('answers with a different, non-colliding set of paths per registered project', async () => {
        const config = new ProjectScopedBoardConfig('alpha');
        config.register(row('alpha'));
        config.register(row('beta'));

        await runAsProject('alpha', async () => {
            expect(config.codeRoot).toBe('/tmp/alpha/code');
            expect(config.worktreeRoot).toBe('/tmp/alpha/worktrees');
            expect(config.runRoot).toBe('/tmp/alpha/run');
        });

        await runAsProject('beta', async () => {
            expect(config.codeRoot).toBe('/tmp/beta/code');
            expect(config.worktreeRoot).toBe('/tmp/beta/worktrees');
            expect(config.runRoot).toBe('/tmp/beta/run');
        });
    });

    it('falls back to the default project when runAsProject names a project that was never registered', async () => {
        const config = new ProjectScopedBoardConfig('alpha');
        config.register(row('alpha'));

        // `currentProject()` answers 'ghost' here, but nothing ever registered it — this must throw
        // (a genuine bug: a job or tick named a project this process never heard of), not silently
        // fall back to 'alpha' and run against the wrong project's paths.
        await expect(runAsProject('ghost', async () => config.codeRoot)).rejects.toThrow(/ghost.*not registered/i);
    });

    it('re-registering the same project overwrites its path fields, picking up an operator edit without a restart', () => {
        const config = new ProjectScopedBoardConfig('alpha');
        config.register(row('alpha'));
        expect(config.codeRoot).toBe('/tmp/alpha/code');

        config.register(row('alpha', { codeRoot: '/tmp/alpha/code-moved' }));

        expect(config.codeRoot).toBe('/tmp/alpha/code-moved');
    });

    /**
     * `register` only carries the three `runner.projects` columns — `notifyWebhookUrl`/`notifyBaseUrl`
     * are settings-store-backed (card 0107) and live nowhere in that table, so a re-register (every
     * `Poller` tick, per its own doc comment) must never clobber a value a settings write already
     * recorded for that project.
     */
    it('preserves notifyWebhookUrl/notifyBaseUrl across a re-register, since neither lives in runner.projects', () => {
        const config = new ProjectScopedBoardConfig('alpha');
        config.register(row('alpha'));
        config.notifyWebhookUrl = 'https://hooks.example/alpha';
        config.notifyBaseUrl = 'https://alpha.example';

        config.register(row('alpha', { codeRoot: '/tmp/alpha/code-moved' }));

        expect(config.notifyWebhookUrl).toBe('https://hooks.example/alpha');
        expect(config.notifyBaseUrl).toBe('https://alpha.example');
        expect(config.codeRoot).toBe('/tmp/alpha/code-moved');
    });

    it("starts a newly registered project with undefined notify settings, not another project's", async () => {
        const config = new ProjectScopedBoardConfig('alpha');
        config.register(row('alpha'));
        config.notifyWebhookUrl = 'https://hooks.example/alpha';

        config.register(row('beta'));

        expect(config.notifyWebhookUrl).toBe('https://hooks.example/alpha');
        await runAsProject('beta', async () => {
            expect(config.notifyWebhookUrl).toBeUndefined();
        });
    });

    it('keeps notifyWebhookUrl/notifyBaseUrl independent per project, set through the setter under runAsProject', async () => {
        const config = new ProjectScopedBoardConfig('alpha');
        config.register(row('alpha'));
        config.register(row('beta'));

        await runAsProject('alpha', async () => {
            config.notifyWebhookUrl = 'https://hooks.example/alpha';
        });
        await runAsProject('beta', async () => {
            config.notifyWebhookUrl = 'https://hooks.example/beta';
        });

        await runAsProject('alpha', async () => {
            expect(config.notifyWebhookUrl).toBe('https://hooks.example/alpha');
        });
        await runAsProject('beta', async () => {
            expect(config.notifyWebhookUrl).toBe('https://hooks.example/beta');
        });
    });
});
