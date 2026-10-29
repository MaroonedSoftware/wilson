import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { StageDispatcher, NotDispatchableError } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { classifyDispatchFailure } from '#modules/jobs/dispatch.outcome.js';
import { NoHostAvailable, type HostPlacer } from '#modules/host/host.placer.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { Worktree, WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { DevServerPortAllocator } from '#modules/lease/dev.server.port.allocator.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import type { DB } from '#modules/data/db.js';
import { MemoryHost } from '#tests/support/memory.host.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

/**
 * The dispatcher's half of placement: it asks the placer before cutting a worktree, defers a
 * `remote` stage nothing can take, cuts a placed stage's tree on its host, hands the agent that host
 * and a copy of the plan there, fetches a passing stage's branch back, and gives the host's worktree
 * and slot back however the stage ends. `WorktreeManager` and the placer are stubbed; their own
 * behaviour is `worktree.remote.test.ts`'s and `host.placer.test.ts`'s to prove.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const makeCard = (id: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
});

const STAGES = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: do it
    placement: any
    setupCommand: 'true'
    onPass: merged
    onFail: implementing
`;

const build = async (place: HostPlacer['place'], createWorktree?: (placement?: RemotePlacement) => Promise<Worktree>) => {
    const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-placement-'));
    const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
    const events = { append: vi.fn(async () => {}) };
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    await board.create(makeCard('0001'), 'initial');

    const worktrees = {
        resolveBranch: vi.fn(() => 'card/0001-x'),
        hasWork: vi.fn(async () => false),
        create: vi.fn(async (_cardId: string, branch: string, _at: string | undefined, placement?: RemotePlacement) =>
            createWorktree
                ? createWorktree(placement)
                : { path: placement ? '/remote/wt/0001' : base, branch, baseSha: 'deadbeef', host: placement?.host, placement },
        ),
        commit: vi.fn(async () => 'committedsha'),
        fetchBack: vi.fn(async () => {}),
        reclaim: vi.fn(async () => {}),
        failedAttemptPatchPath: vi.fn((cardId: string) => join(base, 'run', 'cards', cardId, 'last-failed-attempt.patch')),
    };

    const contexts: ToolContext[] = [];
    const agents = new StageAgentMap();
    agents.set('api', {
        run: async ({ context, planPath }: { context: ToolContext; planPath: string }): Promise<AgentRunOutput> => {
            contexts.push({ ...context, planPath } as ToolContext & { planPath: string });
            return { result: { summary: 'did it', caveats: [] }, usage: { inputTokens: 1 }, truncated: false };
        },
    });
    const verifiers = new StageVerifierMap();
    verifiers.set('implementing', { verify: async () => ({ passed: true, failures: [], changedPaths: ['src/x.ts'] }) });
    const resultSchemas = new StageResultSchemaMap();
    resultSchemas.set('implementing', {} as never);
    const portAllocator = { acquire: vi.fn(async () => ({ ok: true, port: 49000 })) };
    const settings = { get: vi.fn(async () => ({ start: 49000, end: 49099 })) };

    const dispatcher = new StageDispatcher(
        config,
        new StaticStageConfigStore(STAGES),
        board,
        worktrees as unknown as WorktreeManager,
        agents,
        verifiers,
        resultSchemas,
        events as unknown as EventLog,
        silentLogger as never,
        settings as unknown as SettingsStore,
        portAllocator as unknown as DevServerPortAllocator,
        undefined,
        { place: vi.fn(place) } as unknown as HostPlacer,
    );
    return { dispatcher, worktrees, events, contexts, portAllocator };
};

const placementOn = (host: MemoryHost): RemotePlacement => ({
    hostName: 'agent-3',
    sshTarget: 'agent-3',
    host,
    gitSsh: 'ssh',
    codeRoot: '/opt/agent/TGA',
    worktreeRoot: '/opt/agent/wt',
    runRoot: '/opt/agent/run',
    slotKey: 'host:agent-3:slot:1',
});

describe('StageDispatcher placement', () => {
    it('defers a stage no host can take, without cutting a worktree', async () => {
        const { dispatcher, worktrees } = await build(async () => new NoHostAvailable(['agent-3 is draining']));

        const error = await dispatcher.run('0001', 'implementing').catch((err: unknown) => err);

        expect(error).toBeInstanceOf(NotDispatchableError);
        expect((error as NotDispatchableError).reason).toEqual({ kind: 'no-host' });
        expect((error as Error).message).toContain('agent-3 is draining');
        expect(classifyDispatchFailure(error)).toMatchObject({ kind: 'defer' });
        expect(worktrees.create).not.toHaveBeenCalled();
    });

    it('runs a placed stage on its host end to end, then gives the host’s worktree and slot back', async () => {
        const host = new MemoryHost();
        const placement = placementOn(host);
        const { dispatcher, worktrees, events, contexts, portAllocator } = await build(async () => placement);

        const outcome = await dispatcher.run('0001', 'implementing');

        expect(outcome.passed).toBe(true);
        expect(worktrees.create).toHaveBeenCalledWith('0001', 'card/0001-x', undefined, placement);
        // The setup command ran on the host, in the worktree there.
        expect(host.commands).toContainEqual(
            expect.objectContaining({ file: 'true', args: [], options: expect.objectContaining({ cwd: '/remote/wt/0001' }) }),
        );
        // The agent's tools go to the host, and the plan it reads is the copy there.
        expect(contexts[0]?.host).toBe(host);
        const planPath = (contexts[0] as unknown as { planPath: string }).planPath;
        expect(planPath).toBe('/opt/agent/run/cards/0001/plan.md');
        expect(host.files.get(planPath)).toContain('Do the thing.');
        // A host's ports are its own: no lease on this machine's.
        expect(portAllocator.acquire).not.toHaveBeenCalled();
        expect(worktrees.fetchBack).toHaveBeenCalledTimes(1);
        expect(worktrees.reclaim).toHaveBeenCalledWith('0001', placement);
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'stage.placed', payload: { host: 'agent-3', slot: 'host:agent-3:slot:1' } }),
        );
    });

    it('gives the host’s worktree and slot back even when cutting the worktree fails', async () => {
        const placement = placementOn(new MemoryHost());
        const { dispatcher, worktrees } = await build(
            async () => placement,
            async () => {
                throw new Error('git push to agent-3 failed: connection closed');
            },
        );

        await expect(dispatcher.run('0001', 'implementing')).rejects.toThrow('connection closed');
        expect(worktrees.reclaim).toHaveBeenCalledWith('0001', placement);
    });

    it('runs here, exactly as before, when the placer places nothing', async () => {
        const { dispatcher, worktrees, contexts, portAllocator } = await build(async () => undefined);

        await dispatcher.run('0001', 'implementing');

        expect(worktrees.create).toHaveBeenCalledWith('0001', 'card/0001-x');
        expect(portAllocator.acquire).toHaveBeenCalled();
        // A local stage that lands on a terminal stage is still reclaimed the ordinary way; it is
        // never reclaimed as if it were on a host.
        expect(worktrees.reclaim.mock.calls.every(call => (call as unknown[])[1] === undefined)).toBe(true);
        expect(contexts[0]?.host).toBeDefined();
    });
});
