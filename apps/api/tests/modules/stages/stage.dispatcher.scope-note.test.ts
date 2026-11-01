import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * A pipeline where two stages carry their own `extraScope` — `testing` and `e2e` — and two do not,
 * `implementing` and `review`. Enough shape to prove three things at once: another stage's
 * `extraScope` shows up, a stage's own `extraScope` is excluded from its own note (it is already
 * enforced for it directly), and a stage with nothing configured anywhere gets no section at all
 * (the third, separate suite below reuses only the two scope-free stages for that).
 */
const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: testing
    onFail: implementing
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    extraScope:
      - "apps/api/tests/**"
    onPass: e2e
    onFail: implementing
  - name: e2e
    mode: agent
    model: claude-opus
    instructions: run e2e
    extraScope:
      - "apps/e2e/**"
    onPass: review
    onFail: implementing
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`;

const noExtraScopeYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: review
    onFail: implementing
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`;

const cardFor = (stage: string): Card => ({
    frontmatter: {
        id: '0001',
        title: 'do the thing',
        stage,
        dependsOn: [],
        retries: {},
    },
    sections: { 'Files in scope': '- src/x.ts' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/x.ts\n',
});

/**
 * Card 0139: review was reading a card's plan.md and finding test files the testing stage added
 * under its own `extraScope` (`stage.config.ts`) undeclared, because nothing materialized for any
 * stage's agent ever said another stage might legitimately add them. `materializePlan` now folds an
 * "Also in scope" note onto the plan, generated from the loaded stage config — not a second,
 * hand-maintained copy of it — naming every *other* stage's configured `extraScope`. This drives the
 * dispatcher through a full `run()` against a real board and a stubbed worktree/agent/verifier, the
 * same shape `stage.dispatcher.collateral.test.ts` uses, and reads the materialized `plan.md` off
 * disk — the actual file a stage's agent (review included) is given to read.
 */
describe('materializePlan folds other stages\' extraScope into an "Also in scope" note (card 0139)', () => {
    const setUp = async (yaml: string, dispatchStage: string) => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-scope-note-'));

        const worktreeDir = join(base, 'worktree');
        await mkdir(worktreeDir, { recursive: true });
        await exec('git', ['init'], { cwd: worktreeDir });
        await mkdir(join(worktreeDir, 'src'), { recursive: true });
        await writeFile(join(worktreeDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');

        const config = new StaticBoardConfig(uniqueProject(), join(base, 'code'), join(base, 'worktrees'), join(base, 'run'));
        const events = { append: vi.fn<EventLog['append']>(async () => {}) };
        const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(cardFor(dispatchStage), 'initial');

        const worktrees = {
            resolveBranch: vi.fn(() => 'card/0001-do-the-thing'),
            hasWork: vi.fn(async () => false),
            create: vi.fn(async () => ({ path: worktreeDir, baseSha: 'deadbeef' })),
            resume: vi.fn(async () => {
                throw new Error('MARKER: should not resume — hasWork returned false');
            }),
            rebaseOntoHead: vi.fn(async () => {
                throw new Error('MARKER: should not rebase — the run is not resumable');
            }),
            commit: vi.fn(async () => 'committedsha'),
            reclaim: vi.fn(async () => {}),
            // Card 0161: `run` now calls this unconditionally, once per board card, to grant read
            // access to every preserved patch — not just on a failure path.
            failedAttemptPatchPath: vi.fn((cardId: string) => `/tmp/run/cards/${cardId}/last-failed-attempt.patch`),
        };

        const agents = new StageAgentMap();
        agents.set('api', {
            run: async (): Promise<AgentRunOutput> => ({
                result: { summary: 'did the thing' },
                usage: { inputTokens: 10 },
                truncated: false,
            }),
        });

        const verifiers = new StageVerifierMap();
        const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
        for (const name of ['implementing', 'testing', 'e2e', 'review']) verifiers.set(name, verifier);

        const resultSchemas = new StageResultSchemaMap();
        for (const name of ['implementing', 'testing', 'e2e', 'review']) resultSchemas.set(name, {} as never);

        const dispatcher = new StageDispatcher(
            config,
            new StaticStageConfigStore(yaml),
            board,
            worktrees as unknown as WorktreeManager,
            agents,
            verifiers,
            resultSchemas,
            events as unknown as EventLog,
            silentLogger as never,
        );

        return { config, dispatcher, events };
    };

    it('names another stage\'s extraScope, but not the dispatched stage\'s own', async () => {
        const { config, dispatcher } = await setUp(stagesYaml, 'implementing');

        const result = await dispatcher.run('0001', 'implementing');
        expect(result.passed).toBe(true);

        const materialized = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(materialized).toContain('## Also in scope');
        // `implementing` itself has no extraScope, so both configured stages show up.
        expect(materialized).toContain('- `testing`: `apps/api/tests/**`');
        expect(materialized).toContain('- `e2e`: `apps/e2e/**`');
        // `review` configures no extraScope at all, so it earns no line.
        expect(materialized).not.toContain('`review`:');
    });

    it("excludes the dispatched stage's own extraScope from its own note", async () => {
        const { config, dispatcher } = await setUp(stagesYaml, 'testing');

        const result = await dispatcher.run('0001', 'testing');
        expect(result.passed).toBe(true);

        const materialized = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(materialized).toContain('## Also in scope');
        // `e2e`'s extraScope is genuinely someone else's — it shows up.
        expect(materialized).toContain('- `e2e`: `apps/e2e/**`');
        // `testing`'s own extraScope is already enforced for it directly by ScopeGuard; restating it
        // here would say nothing new, and the diff a review reads would otherwise show a test file
        // "declared" only by the note explaining it, not by anything the testing stage did not
        // already have.
        expect(materialized).not.toContain('- `testing`: `apps/api/tests/**`');
    });

    it('adds no heading and no dangling sentence when no stage anywhere configures extraScope', async () => {
        const { config, dispatcher } = await setUp(noExtraScopeYaml, 'implementing');

        const result = await dispatcher.run('0001', 'implementing');
        expect(result.passed).toBe(true);

        const materialized = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(materialized).not.toContain('Also in scope');
        expect(materialized).not.toContain('extraScope');
    });

    /**
     * Card 0163: a stage with its own `extraScope` was never told about it. `ScopeGuard`'s allow list
     * (`scoped` in `stage.dispatcher.ts`'s `run`) already includes `stage.extraScope`, but the plan
     * materialized for the agent said nothing about it — only `otherStagesScopeNote`, which
     * deliberately excludes the running stage. That silence is what led card 0154's `testing` stage
     * to call `request_scope` for a plain `*.test.ts` file its own `extraScope` already covered.
     * `ownScopeNote` fixes this by folding a "## Your scope" section into the plan, naming the
     * running stage's own `extraScope` — distinct from "## Also in scope", which is about *other*
     * stages. Reuses this describe block's `setUp`, `stagesYaml` and `noExtraScopeYaml`.
     */
    it('names the dispatched stage\'s own extraScope under "## Your scope", separate from "## Also in scope"', async () => {
        const { config, dispatcher } = await setUp(stagesYaml, 'testing');

        const result = await dispatcher.run('0001', 'testing');
        expect(result.passed).toBe(true);

        const materialized = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(materialized).toContain('## Your scope');
        // The section names testing's own extraScope glob directly (not "other stage" phrasing).
        expect(materialized).toContain('- `apps/api/tests/**`');
        // The two sections stay distinguishable: "Your scope" is what this stage may itself write;
        // "Also in scope" (asserted above, in the card 0139 suite) is what other stages may write.
        const ownIndex = materialized.indexOf('## Your scope');
        const otherIndex = materialized.indexOf('## Also in scope');
        expect(ownIndex).toBeGreaterThan(-1);
        expect(otherIndex).toBeGreaterThan(-1);
        expect(ownIndex).not.toBe(otherIndex);
    });

    it('adds no "## Your scope" heading for a stage that configures no extraScope', async () => {
        const { config, dispatcher } = await setUp(stagesYaml, 'implementing');

        const result = await dispatcher.run('0001', 'implementing');
        expect(result.passed).toBe(true);

        const materialized = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(materialized).not.toContain('## Your scope');
    });

    it('adds no "## Your scope" heading anywhere when no stage configures extraScope', async () => {
        const { config, dispatcher } = await setUp(noExtraScopeYaml, 'implementing');

        const result = await dispatcher.run('0001', 'implementing');
        expect(result.passed).toBe(true);

        const materialized = await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8');
        expect(materialized).not.toContain('## Your scope');
        expect(materialized).not.toContain('extraScope');
    });

    it('records the dispatched stage\'s full writable scope, including its own extraScope, on stage.dispatched', async () => {
        const { dispatcher, events } = await setUp(stagesYaml, 'testing');

        const result = await dispatcher.run('0001', 'testing');
        expect(result.passed).toBe(true);

        const dispatched = events.append.mock.calls
            .map(([event]) => event as { type: string; payload?: { scope?: string[] } })
            .find((event: { type: string }) => event.type === 'stage.dispatched');
        expect(dispatched).toBeDefined();
        // Before card 0163, this payload carried only `filesInScope(card)` (`src/x.ts`), understating
        // what ScopeGuard actually allowed — `testing`'s own `apps/api/tests/**` was enforced but
        // never recorded here.
        expect(dispatched!.payload!.scope).toEqual(expect.arrayContaining(['src/x.ts', 'apps/api/tests/**']));
    });
});
