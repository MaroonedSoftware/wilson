import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { DevServerPortAllocator, PortAcquireResult } from '#modules/lease/dev.server.port.allocator.js';
import type { ToolContext } from '#modules/agent/tools/tool.context.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const makeCard = (id: string): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'testing', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
});

/** A script `setupCommand` runs that records the PORT it saw (or 'unset') to `outPath`. */
const writeSetupScript = (path: string, outPath: string): Promise<void> =>
    writeFile(path, `require('fs').writeFileSync(${JSON.stringify(outPath)}, process.env.PORT ?? 'unset');\n`, 'utf8');

/** A `WorktreeManager` stub that hands each card its own pre-made directory, never resumes or rebases. */
const makeWorktrees = (dirs: Record<string, string>) => ({
    resolveBranch: vi.fn((card: Card) => `card/${card.frontmatter.id}-do-the-thing`),
    hasWork: vi.fn(async () => false),
    create: vi.fn(async (cardId: string) => ({ path: dirs[cardId]!, baseSha: 'deadbeef' })),
    resume: vi.fn(async () => {
        throw new Error('MARKER: should not resume');
    }),
    rebaseOntoHead: vi.fn(async () => {
        throw new Error('MARKER: should not rebase');
    }),
    commit: vi.fn(async () => 'committedsha'),
    reclaim: vi.fn(async () => {}),
    failedAttemptPatchPath: vi.fn((cardId: string) => `/tmp/run/cards/${cardId}/last-failed-attempt.patch`),
});

/**
 * Card 0027. `StageDispatcher.run` acquires a port ahead of a stage's `setupCommand` and threads it
 * into both `runConfiguredCommand` (via `port`) and the agent's `ToolContext` (via `context.port`,
 * read by `bash.tool.ts`) — this is task 3, "hand it to the stage". `DevServerPortAllocator` and
 * `SettingsStore` are stubbed here (their own contracts are covered by
 * `dev.server.port.allocator.test.ts` and `dev.server.port.range.setting.test.ts`); what this file
 * proves is the dispatcher's own wiring: when it asks, what it does with an allocation or a refusal,
 * and that a `worktree: none` stage never asks at all.
 */
describe('StageDispatcher dev server port allocation', () => {
    const buildDispatcher = async (opts: {
        base: string;
        cardId: string;
        stageWorktree?: 'none';
        settingsGet: () => Promise<{ start: number; end: number } | undefined>;
        acquire: (range: { start: number; end: number }, project: string, cardId: string) => Promise<PortAcquireResult>;
        outPath: string;
    }) => {
        const { base, cardId, stageWorktree, settingsGet, acquire, outPath } = opts;

        const scriptPath = join(base, `setup-${cardId}.js`);
        await writeSetupScript(scriptPath, outPath);

        const stagesYaml = `
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
${stageWorktree ? `    worktree: ${stageWorktree}\n` : ''}    setupCommand: node ${scriptPath}
`;

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(makeCard(cardId), 'initial');

        const wtDir = join(base, `wt-${cardId}`);
        await mkdir(wtDir, { recursive: true });
        const worktrees = makeWorktrees({ [cardId]: wtDir });

        const contexts: ToolContext[] = [];
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async ({ context }: { context: ToolContext }): Promise<AgentRunOutput> => {
                contexts.push(context);
                return { result: { summary: 'did the thing', caveats: [] }, usage: { inputTokens: 1 }, truncated: false };
            },
        });

        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
        verifiers.set('testing', verifier);
        const resultSchemas = new StageResultSchemaMap();
        resultSchemas.set('testing', {} as never);

        const settings = { get: vi.fn(settingsGet) };
        const portAllocator = { acquire: vi.fn(acquire) };

        const dispatcher = new StageDispatcher(
            config,
            new StaticStageConfigStore(stagesYaml),
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
            settings as unknown as SettingsStore,
            portAllocator as unknown as DevServerPortAllocator,
        );

        return { dispatcher, config, settings, portAllocator, contexts };
    };

    it('acquires a port from the configured range and hands the same PORT to setupCommand and the agent', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-port-'));
        const outPath = join(base, 'seen-port');
        const range = { start: 49000, end: 49099 };

        const { dispatcher, config, portAllocator, contexts } = await buildDispatcher({
            base,
            cardId: '0001',
            settingsGet: async () => range,
            acquire: async () => ({ ok: true, port: 49050 }),
            outPath,
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(portAllocator.acquire).toHaveBeenCalledWith(range, config.project, '0001');
        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.port).toBe(49050);
        await expect(readFile(outPath, 'utf8')).resolves.toBe('49050');
    });

    it('takes no lease and injects no PORT when no range is configured — identical to before this card', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-port-'));
        const outPath = join(base, 'seen-port');

        const { dispatcher, portAllocator, contexts } = await buildDispatcher({
            base,
            cardId: '0001',
            settingsGet: async () => undefined,
            acquire: async () => {
                throw new Error('MARKER: allocator must not be called when no range is configured');
            },
            outPath,
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(portAllocator.acquire).not.toHaveBeenCalled();
        expect(contexts[0]?.port).toBeUndefined();
        await expect(readFile(outPath, 'utf8')).resolves.toBe('unset');
    });

    it('takes no lease for a stage configured worktree: none, even with a range configured', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-port-'));
        const outPath = join(base, 'seen-port');
        const range = { start: 49100, end: 49199 };

        const { dispatcher, portAllocator, contexts } = await buildDispatcher({
            base,
            cardId: '0001',
            stageWorktree: 'none',
            settingsGet: async () => range,
            acquire: async () => {
                throw new Error('MARKER: allocator must not be called for a worktree: none stage');
            },
            outPath,
        });

        const result = await dispatcher.run('0001', 'testing');

        expect(result.passed).toBe(true);
        expect(portAllocator.acquire).not.toHaveBeenCalled();
        expect(contexts[0]?.port).toBeUndefined();
    });

    it('fails the stage with a reason naming the range when every port is held, rather than crashing silently or shipping no PORT', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-port-'));
        const outPath = join(base, 'seen-port');
        const range = { start: 49200, end: 49299 };

        const { dispatcher } = await buildDispatcher({
            base,
            cardId: '0001',
            settingsGet: async () => range,
            acquire: async () => ({ ok: false, reason: `every port in ${range.start}-${range.end} is held or already bound on this machine` }),
            outPath,
        });

        await expect(dispatcher.run('0001', 'testing')).rejects.toThrow(
            /could not allocate a dev server port for 0001.*49200-49299/,
        );
    });

    /**
     * Acceptance criterion: "two cards dispatched at once get different ports." This runs two real,
     * concurrent `StageDispatcher.run` calls sharing one allocator mock that hands out a distinct
     * port per card, and checks each card's own `setupCommand` and agent context saw only its own
     * port — never the other's — proving `port` is carried correctly through one dispatch and never
     * bleeds across two running at once.
     */
    it('gives two cards dispatched at once different ports, each seen consistently by its own setupCommand and agent', async () => {
        // Each harness gets its own base directory and its own `StaticStageConfigStore` — two
        // dispatchers sharing one config store is not what this test is about; it is the shared
        // `portFor` allocator mock below that models two cards genuinely contending for one range.
        const baseA = await mkdtemp(join(tmpdir(), 'stage-dispatcher-port-a-'));
        const baseB = await mkdtemp(join(tmpdir(), 'stage-dispatcher-port-b-'));
        const range = { start: 49300, end: 49399 };
        const portFor: Record<string, number> = { '0001': 49301, '0002': 49302 };

        const outPathA = join(baseA, 'seen-port-a');
        const outPathB = join(baseB, 'seen-port-b');

        const harnessA = await buildDispatcher({
            base: baseA,
            cardId: '0001',
            settingsGet: async () => range,
            acquire: async (_r, _p, cardId) => ({ ok: true, port: portFor[cardId]! }),
            outPath: outPathA,
        });
        const harnessB = await buildDispatcher({
            base: baseB,
            cardId: '0002',
            settingsGet: async () => range,
            acquire: async (_r, _p, cardId) => ({ ok: true, port: portFor[cardId]! }),
            outPath: outPathB,
        });

        const [resultA, resultB] = await Promise.all([harnessA.dispatcher.run('0001', 'testing'), harnessB.dispatcher.run('0002', 'testing')]);

        expect(resultA.passed).toBe(true);
        expect(resultB.passed).toBe(true);
        expect(harnessA.contexts[0]?.port).toBe(49301);
        expect(harnessB.contexts[0]?.port).toBe(49302);
        expect(harnessA.contexts[0]?.port).not.toBe(harnessB.contexts[0]?.port);
        await expect(readFile(outPathA, 'utf8')).resolves.toBe('49301');
        await expect(readFile(outPathB, 'utf8')).resolves.toBe('49302');
    });
});
