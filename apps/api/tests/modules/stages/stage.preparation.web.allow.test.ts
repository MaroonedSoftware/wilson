import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { ProjectStages, StageConfig } from '#modules/stages/stage.config.js';
import { prepareStage, type StagePreparationDeps } from '#modules/stages/stage.preparation.js';
import type { Worktree } from '#modules/worktree/worktree.manager.js';
import { stageDefaults } from '#tests/modules/stages/stage.fixture.js';

/**
 * Card 0020: the project's `webAllow` has to reach the guard the adapter reads it from. These run the
 * real `prepareStage` and check the guard it builds, so a list that is configured but never threaded
 * through — every fetch silently refused — fails here rather than in a live run.
 */
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const card: Card = {
    frontmatter: { id: '0020', title: 'web', stage: 'implementing', dependsOn: [], retries: {} },
    sections: {},
    body: '## Goal\n\nFetch a page.',
};

const stage = {
    ...stageDefaults,
    name: 'implementing',
    mode: 'agent',
    worktree: 'rw',
    provider: 'anthropic',
    model: 'claude-opus',
    instructions: 'do it',
    allowedCommands: [],
    worktreeFrom: 'branch',
    extraScope: [],
    baselineCheck: true,
    maxSteps: 60,
    maxOutputTokens: 16000,
    onPass: 'testing',
    onFail: 'implementing',
    maxKickbacks: 3,
} as StageConfig;

const prepare = async (webAllow: string[] | undefined) => {
    const base = await mkdtemp(join(tmpdir(), 'prep-web-'));
    const worktreePath = join(base, 'worktree');
    await mkdir(worktreePath, { recursive: true });
    const deps = {
        config: new StaticBoardConfig('p', base, join(base, 'worktrees'), join(base, 'run')),
        worktrees: { failedAttemptPatchPath: (id: string) => join(base, 'run', 'cards', id, 'last-failed-attempt.patch') },
        events: { append: async () => {} } as unknown as EventLog,
        logger: silentLogger,
    } as unknown as StagePreparationDeps;
    const stages = {
        scopeViolation: 'widen',
        alwaysAllowed: [],
        ...(webAllow ? { webAllow } : {}),
        deny: [],
        sandbox: { enabled: false, allowedDomains: [] },
        stages: [stage],
    } as unknown as ProjectStages;
    return prepareStage(deps, {
        cardId: '0020',
        stageName: 'implementing',
        stages,
        stage,
        card,
        pinnedSha: undefined,
        worktree: { path: worktreePath, baseSha: 'deadbeef' } as unknown as Worktree,
        boardCards: [card],
    });
};

describe('prepareStage threads webAllow to the scope guard (card 0020)', () => {
    it("carries the project's webAllow onto the guard, so an allowed host may be fetched", async () => {
        const { scope } = await prepare(['github.com']);
        expect(scope.webAllow).toEqual(['github.com']);
        expect(scope.checkWeb('https://github.com/org/repo')).toMatchObject({ allowed: true, host: 'github.com' });
        expect(scope.checkWeb('https://evil.com')).toMatchObject({ allowed: false, host: 'evil.com' });
    });

    it('leaves the guard refusing every fetch when the project names no host', async () => {
        const { scope } = await prepare([]);
        expect(scope.webAllow).toEqual([]);
        expect(scope.checkWeb('https://github.com/org/repo')).toMatchObject({ allowed: false });
    });
});
