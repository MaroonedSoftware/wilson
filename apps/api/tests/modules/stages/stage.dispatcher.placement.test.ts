import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
import { HostLostError, type RemotePlacement } from '#modules/host/placement.js';
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

const build = async (
    place: HostPlacer['place'],
    createWorktree?: (placement?: RemotePlacement) => Promise<Worktree>,
    options: { passes?: boolean; alive?: boolean; localBusy?: boolean } = {},
) => {
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
    const passes = options.passes ?? true;
    verifiers.set('implementing', {
        verify: async () => ({ passed: passes, failures: passes ? [] : ['build failed: ssh connection closed'], changedPaths: ['src/x.ts'] }),
    });
    const resultSchemas = new StageResultSchemaMap();
    resultSchemas.set('implementing', {} as never);
    const portAllocator = { acquire: vi.fn(async () => ({ ok: true, port: 49000 })) };
    const settings = { get: vi.fn(async () => ({ start: 49000, end: 49099 })) };

    const placer = {
        place: vi.fn(place),
        isAlive: vi.fn(async () => options.alive ?? true),
        markLost: vi.fn(async () => {}),
        takeLocalSlot: vi.fn(async () => (options.localBusy ? { busy: 2 } : { key: 'local:slot:1' })),
        releaseSlot: vi.fn(async () => {}),
    };

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
        placer as unknown as HostPlacer,
    );
    return { dispatcher, worktrees, events, contexts, portAllocator, placer, board, base };
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
        const { dispatcher, worktrees, events, contexts, portAllocator, placer } = await build(async () => placement);

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
        expect(placer.releaseSlot).toHaveBeenCalledWith('host:agent-3:slot:1', expect.any(String), '0001');
        expect(placer.takeLocalSlot).not.toHaveBeenCalled();
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

    it('retries a stage whose host stopped answering, marking the host lost and writing no kickback', async () => {
        const placement = placementOn(new MemoryHost());
        const { dispatcher, worktrees, events, placer, board } = await build(async () => placement, undefined, { passes: false, alive: false });

        const error = await dispatcher.run('0001', 'implementing').catch((err: unknown) => err);

        expect(error).toBeInstanceOf(HostLostError);
        expect(classifyDispatchFailure(error)).toEqual({ kind: 'retry' });
        expect(placer.markLost).toHaveBeenCalledWith(placement, expect.stringContaining('ssh connection closed'));
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'stage.host-lost', payload: expect.objectContaining({ host: 'agent-3' }) }),
        );
        // No transition: the card is where it was, with no kickback counted against it.
        const card = await board.read('0001');
        expect(card.frontmatter.stage).toBe('implementing');
        expect(card.frontmatter.retries).toEqual({});
        expect(worktrees.commit).not.toHaveBeenCalled();
        expect(worktrees.reclaim).toHaveBeenCalledWith('0001', placement);
    });

    it('kicks back as usual when the stage fails on a host that still answers', async () => {
        const placement = placementOn(new MemoryHost());
        const { dispatcher, placer } = await build(async () => placement, undefined, { passes: false, alive: true });

        const outcome = await dispatcher.run('0001', 'implementing');

        expect(outcome.passed).toBe(false);
        expect(outcome.transitionedTo).toBe('implementing');
        expect(placer.markLost).not.toHaveBeenCalled();
    });

    it('turns an error thrown on a host that no longer answers into a retry, keeping the original as its cause', async () => {
        const placement = placementOn(new MemoryHost());
        const original = new Error('ssh agent-3 failed: Connection closed by remote host');
        const { dispatcher } = await build(
            async () => placement,
            async () => {
                throw original;
            },
            { alive: false },
        );

        const error = (await dispatcher.run('0001', 'implementing').catch((err: unknown) => err)) as HostLostError;

        expect(error).toBeInstanceOf(HostLostError);
        expect(error.cause).toBe(original);
    });

    it('copies every preserved patch that exists to the host, and points the plan’s patch paths at the copies', async () => {
        const host = new MemoryHost();
        const placement = placementOn(host);
        const { dispatcher, board, base, contexts } = await build(async () => placement);
        const localPatch = join(base, 'run', 'cards', '0002', 'last-failed-attempt.patch');
        await board.create(
            { ...makeCard('0002'), frontmatter: { ...makeCard('0002').frontmatter, stage: 'implementing' } },
            'a card that failed once',
        );
        await mkdir(join(base, 'run', 'cards', '0002'), { recursive: true });
        await writeFile(localPatch, '+half done\n', 'utf8');
        await board.write('0001', 'cite 0002', current => ({
            ...current,
            body: `${current.body}\nStart from ${localPatch}.\n`,
        }));

        await dispatcher.run('0001', 'implementing');

        const remotePatch = '/opt/agent/run/cards/0002/last-failed-attempt.patch';
        expect(host.files.get(remotePatch)).toBe('+half done\n');
        // 0001 never failed, so nothing was copied for it.
        expect(host.files.has('/opt/agent/run/cards/0001/last-failed-attempt.patch')).toBe(false);
        const plan = host.files.get('/opt/agent/run/cards/0001/plan.md')!;
        expect(plan).toContain(`Start from ${remotePatch}.`);
        expect(plan).not.toContain(localPatch);
        expect(contexts).toHaveLength(1);
    });

    it('holds one of this machine’s slots for a stage it runs here, and gives it back when the stage ends', async () => {
        const { dispatcher, placer } = await build(async () => undefined);

        await dispatcher.run('0001', 'implementing');

        expect(placer.takeLocalSlot).toHaveBeenCalledTimes(1);
        expect(placer.releaseSlot).toHaveBeenCalledWith('local:slot:1', expect.any(String), '0001');
    });

    it('defers a stage that runs here when every local slot is held, without cutting a worktree', async () => {
        const { dispatcher, worktrees } = await build(async () => undefined, undefined, { localBusy: true });

        const error = await dispatcher.run('0001', 'implementing').catch((err: unknown) => err);

        expect((error as NotDispatchableError).reason).toEqual({ kind: 'no-local-slot' });
        expect((error as Error).message).toContain('all 2 of its local-stage-slots are in use');
        expect(classifyDispatchFailure(error)).toMatchObject({ kind: 'defer' });
        expect(worktrees.create).not.toHaveBeenCalled();
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
