import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { StageAgentMap, type AgentRunInput, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageHeldError, StageInterruptedError } from '#modules/agent/stage.interrupt.js';
import { ScopeKickbackError } from '#modules/agent/tools/index.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import { EvalFixtureRepository } from '#modules/evals/eval.fixture.repository.js';
import { EvalRunRepository, type EvalArm } from '#modules/evals/eval.run.repository.js';
import { EvalRunner, type EvalStep } from '#modules/evals/eval.runner.js';
import { evalRunId } from '#modules/evals/eval.run.id.js';
import { EventLog } from '#modules/events/event.log.js';
import { NoHostAvailable } from '#modules/host/host.placer.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import { hostSlotKey } from '#modules/host/placement.js';
import { gitSshCommand, SshHost } from '#modules/host/ssh.execution.host.js';
import { SshGitTransport } from '#modules/host/ssh.git.transport.js';
import { LeaseService } from '#modules/lease/lease.service.js';
import { applyCandidate, documentFromLanes, lanesFromDocument } from '#modules/stages/lane.rows.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { StageVerifierMap, type StageVerifier, type VerificationInput } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const FAKE_SSH = fileURLToPath(new URL('../../support/fake.ssh.sh', import.meta.url));
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const gitIn = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

const lanes = `
stages:
  - name: review
    mode: agent
    adapter: api
    provider: anthropic
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: review
`;

const plan: Card = {
    frontmatter: { id: '0001', title: 'the card', stage: 'review', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- x.ts\n- new.ts' },
    body: '## Goal\n\nThe plan.\n\n## Files in scope\n\n- x.ts\n- new.ts\n',
};

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('EvalRunner', () => {
    let project: string;
    let codeRoot: string;
    let hostClone: string;
    let baseSha: string;
    let headSha: string;
    let placement: RemotePlacement;
    let runs: EvalRunRepository;
    let events: EventLog;
    let worktrees: WorktreeManager;
    let leases: LeaseService;
    let board: PostgresBoardRepository;
    let fixtureId: string;
    let agent: (input: AgentRunInput) => Promise<AgentRunOutput>;
    let verify: StageVerifier['verify'];
    let hostBusy: boolean;
    let draining: boolean;
    let released: string[];

    const newRunner = (config: StaticBoardConfig) => {
        const agents = new StageAgentMap();
        agents.set('api', { run: input => agent(input) });
        const verifiers = new StageVerifierMap();
        verifiers.set('review', { verify: input => verify(input) });
        const schemas = new StageResultSchemaMap();
        schemas.set('review', {} as never);
        const placer = {
            place: async (_project: string, id: string) => {
                if (hostBusy) return new NoHostAvailable(['agent-t has all 1 slot in use']);
                await leases.acquire(placement.slotKey, project, id);
                return placement;
            },
            releaseSlot: async (key: string, _project: string, id: string) => {
                released.push(id);
                await leases.release(key, project, id);
            },
            isAlive: async () => true,
            markLost: async () => {},
        };
        const settings = { get: async () => draining };
        return new EvalRunner(
            config,
            runs,
            new EvalFixtureRepository(config, db),
            worktrees,
            agents,
            verifiers,
            schemas,
            events,
            placer as never,
            settings as never,
            logger as never,
        );
    };

    let runner: EvalRunner;

    const startBatch = async (arms: EvalArm[] = ['current'], maxOutputTokens = 1000) => {
        const current = documentFromLanes(lanesFromDocument(lanes, new Map(), 'test'));
        return runs.createBatch({
            host: 'agent-t',
            runsPerFixture: arms.length,
            maxOutputTokens,
            currentLanes: current,
            ...(arms.includes('candidate') && { candidateLanes: current }),
            learnings: '',
            runs: arms.map(arm => ({ fixtureId, arm })),
        });
    };

    const drain = async (batchId: string): Promise<EvalStep[]> => {
        const steps: EvalStep[] = [];
        for (let i = 0; i < 10; i++) {
            const step = await runner.step(batchId);
            steps.push(step);
            if (step.kind !== 'next') break;
        }
        return steps;
    };

    beforeEach(async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), 'eval-runner-')));
        codeRoot = join(base, 'code');
        hostClone = join(base, 'host', 'clone');
        for (const repo of [codeRoot, hostClone]) {
            await mkdir(repo, { recursive: true });
            await gitIn(repo, 'init', '-q', '-b', 'main');
            await gitIn(repo, 'config', 'user.email', 'test@example.com');
            await gitIn(repo, 'config', 'user.name', 'Test');
        }
        await writeFile(join(codeRoot, 'x.ts'), 'one\n');
        await gitIn(codeRoot, 'add', '-A');
        await gitIn(codeRoot, 'commit', '-qm', 'base');
        baseSha = await gitIn(codeRoot, 'rev-parse', 'HEAD');
        await writeFile(join(codeRoot, 'x.ts'), 'two\n');
        await gitIn(codeRoot, 'commit', '-qam', 'the card');
        headSha = await gitIn(codeRoot, 'rev-parse', 'HEAD');

        project = uniqueProject();
        const config = new StaticBoardConfig(project, codeRoot, join(base, 'wt'), join(base, 'run'));
        placement = {
            hostName: 'agent-t',
            host: new SshHost('agent-t', FAKE_SSH),
            git: new SshGitTransport('agent-t', gitSshCommand(FAKE_SSH)),
            codeRoot: hostClone,
            worktreeRoot: join(base, 'host', 'wt'),
            runRoot: join(base, 'host', 'run'),
            slotKey: hostSlotKey(`agent-${project}`, 1),
        };
        events = new EventLog(db, logger as never);
        board = new PostgresBoardRepository(config, db, events);
        leases = new LeaseService(db, board);
        worktrees = new WorktreeManager(config, logger as never);
        runs = new EvalRunRepository(config, db);
        const fixture = await new EvalFixtureRepository(config, db).insert({
            sourceCardId: '0001',
            stage: 'review',
            sourceEventId: '1',
            planVersionId: '1',
            plan,
            baseSha,
            headSha,
        });
        fixtureId = fixture!.id;
        hostBusy = false;
        draining = false;
        released = [];
        agent = async () => ({ result: { summary: 'ok' }, usage: { inputTokens: 10, outputTokens: 100, cachedInputTokens: 5 }, truncated: false });
        verify = async () => ({ passed: true, failures: [], changedPaths: [] });
        runner = newRunner(config);
    });

    it('records a passing run, and writes nothing a card’s accounting reads', async () => {
        const batch = await startBatch();
        const since = DateTime.now().minus({ minutes: 1 });

        expect((await drain(batch.id)).map(step => step.kind)).toEqual(['next', 'done']);

        const [run] = await runs.runs(batch.id);
        expect(run).toMatchObject({ status: 'passed', inputTokens: 10, outputTokens: 100, cachedInputTokens: 5 });
        expect(run!.wallClockMs).toBeGreaterThanOrEqual(0);
        expect((await runs.batch(batch.id))?.status).toBe('finished');

        expect(await events.outputTokensSince(project, since)).toBe(0);
        expect(await events.totalInputTokens(project, evalRunId(run!.id))).toBe(0);
        const cards = await db.selectFrom('wilson.cards').select('id').where('project', '=', project).execute();
        expect(cards).toEqual([]);
    });

    it('gives the verifier the tree at head, with the diff measured from the attempt’s fork point', async () => {
        let changed: string[] = [];
        let tip = '';
        verify = async ({ worktree }: VerificationInput) => {
            changed = await worktrees.changedPaths(worktree);
            tip = await gitIn(worktree.path, 'rev-parse', 'HEAD');
            expect(worktree.baseSha).toBe(baseSha);
            return { passed: true, failures: [], changedPaths: changed };
        };
        const batch = await startBatch();

        await drain(batch.id);

        expect(tip).toBe(headSha);
        expect(changed).toEqual(['x.ts']);
    });

    it('holds the host slot against other callers during a run, and releases it after', async () => {
        let contested: unknown;
        agent = async () => {
            contested = await leases.acquire(placement.slotKey, project, '0999');
            return { result: {}, truncated: false };
        };
        const batch = await startBatch();

        await drain(batch.id);

        expect(contested).toMatchObject({ acquired: false });
        const [run] = await runs.runs(batch.id);
        expect(released).toEqual([evalRunId(run!.id)]);
        const left = await db.selectFrom('wilson.leases').select('cardId').where('project', '=', project).execute();
        expect(left).toEqual([]);
    });

    it('keeps the run’s work as a patch and leaves no worktree, branch, ref or run folder behind', async () => {
        agent = async ({ context }) => {
            await writeFile(join(context.worktreeRoot, 'new.ts'), 'added\n');
            return { result: {}, truncated: false };
        };
        const batch = await startBatch();

        await drain(batch.id);

        const [run] = await runs.runs(batch.id);
        const id = evalRunId(run!.id);
        expect(run!.patch).toContain('new.ts');
        expect(run!.patch).toContain('+added');

        await expect(access(join(placement.worktreeRoot, id))).rejects.toThrow();
        await expect(access(join(placement.runRoot, 'cards', id))).rejects.toThrow();
        expect(await gitIn(hostClone, 'branch', '--list', `eval/${id}`)).toBe('');
        expect(await gitIn(codeRoot, 'branch', '--list', `eval/${id}`)).toBe('');
        expect(await gitIn(hostClone, 'for-each-ref', 'refs/wilson/base/')).toBe('');
        expect(await gitIn(hostClone, 'worktree', 'list', '--porcelain')).not.toContain(id);
    });

    it('runs each arm under its own lanes, frozen when the batch began', async () => {
        const seen: string[] = [];
        agent = async ({ stage }) => {
            seen.push(stage.instructions);
            return { result: {}, truncated: false };
        };
        const config = lanesFromDocument(lanes, new Map(), 'test');
        const batch = await runs.createBatch({
            host: 'agent-t',
            runsPerFixture: 1,
            maxOutputTokens: 1000,
            currentLanes: documentFromLanes(config),
            candidateLanes: documentFromLanes(applyCandidate(config, { lane: 'review', instructions: 'review it harder' }, 'test')),
            learnings: '',
            runs: [
                { fixtureId, arm: 'current' },
                { fixtureId, arm: 'candidate' },
            ],
        });

        await drain(batch.id);

        expect(seen).toEqual(['review it', 'review it harder']);
    });

    it('records a verifier’s failures as the run’s, and goes on', async () => {
        verify = async () => ({ passed: false, failures: ['build failed'], changedPaths: [] });
        const batch = await startBatch(['current', 'current']);

        await drain(batch.id);

        const results = await runs.runs(batch.id);
        expect(results.map(run => run.status)).toEqual(['failed', 'failed']);
        expect(results[0]!.failures).toEqual(['build failed']);
    });

    it('fails a passing run whose tree holds a write outside its scope', async () => {
        agent = async ({ context }) => {
            await writeFile(join(context.worktreeRoot, 'outside.ts'), 'nope\n');
            return { result: {}, truncated: false };
        };
        const batch = await startBatch();

        await drain(batch.id);

        const [run] = await runs.runs(batch.id);
        expect(run!.status).toBe('failed');
        expect(run!.failures.join()).toContain('outside.ts');
    });

    it('counts a scope kickback as a failure of the run', async () => {
        agent = async () => {
            throw new ScopeKickbackError('outside.ts', 'refused');
        };
        const batch = await startBatch();

        await drain(batch.id);

        expect((await runs.runs(batch.id))[0]).toMatchObject({ status: 'failed', failures: [expect.stringContaining('outside.ts')] });
    });

    it('keeps an interruption apart from a failure, and goes on', async () => {
        agent = async () => {
            throw new StageInterruptedError('x', 'review', { outputTokens: 7 }, { baseSha });
        };
        const batch = await startBatch(['current', 'current']);

        expect((await runner.step(batch.id)).kind).toBe('next');
        expect((await runs.runs(batch.id))[0]).toMatchObject({ status: 'interrupted', outputTokens: 7 });
    });

    it('stops the batch when the account is held, skipping what has not started', async () => {
        agent = async () => {
            throw new StageHeldError(
                'x',
                'review',
                {},
                { baseSha },
                { account: 'a', limitType: 'five_hour', resetsAt: Date.now() + 1000 },
                Date.now() + 1000,
            );
        };
        const batch = await startBatch(['current', 'current']);

        expect((await runner.step(batch.id)).kind).toBe('done');

        expect((await runs.runs(batch.id)).map(run => run.status)).toEqual(['interrupted', 'skipped']);
        const stopped = await runs.batch(batch.id);
        expect(stopped?.status).toBe('stopped');
        expect(stopped?.stopReason).toContain('is held');
    });

    it('stops the batch once it has spent its limit', async () => {
        const batch = await startBatch(['current', 'current'], 100);

        expect((await drain(batch.id)).map(step => step.kind)).toEqual(['next', 'done']);

        expect((await runs.runs(batch.id)).map(run => run.status)).toEqual(['passed', 'skipped']);
        expect((await runs.batch(batch.id))?.stopReason).toContain('100');
    });

    it('waits for a busy host, giving the run back and saying why', async () => {
        hostBusy = true;
        const batch = await startBatch();

        expect((await runner.step(batch.id)).kind).toBe('wait');

        expect((await runs.runs(batch.id))[0]).toMatchObject({ status: 'queued' });
        expect((await runs.batch(batch.id))?.waitingReason).toContain('slot');

        hostBusy = false;
        expect((await runner.step(batch.id)).kind).toBe('next');
        expect((await runs.batch(batch.id))?.waitingReason).toBeUndefined();
    });

    it('waits while the server drains', async () => {
        draining = true;
        const batch = await startBatch();

        expect((await runner.step(batch.id)).kind).toBe('wait');
        expect((await runs.runs(batch.id))[0]).toMatchObject({ status: 'queued' });
    });

    it('does nothing for a stopped batch', async () => {
        const batch = await startBatch();
        await runs.stopBatch(batch.id, 'stopped by the operator');

        expect((await runner.step(batch.id)).kind).toBe('done');
        expect((await runs.runs(batch.id))[0]!.status).toBe('skipped');
    });

    it('marks an unusable config as errored without placing anything', async () => {
        const batch = await runs.createBatch({
            host: 'agent-t',
            runsPerFixture: 1,
            maxOutputTokens: 1000,
            currentLanes: { stages: [] },
            learnings: '',
            runs: [{ fixtureId, arm: 'current' }],
        });

        await drain(batch.id);

        expect((await runs.runs(batch.id))[0]!.status).toBe('errored');
        expect(released).toEqual([]);
    });

    it('leaves a running eval’s event out of the activity feed', async () => {
        const batch = await startBatch();
        await drain(batch.id);
        const [run] = await runs.runs(batch.id);
        await events.append({ project, cardId: evalRunId(run!.id), stage: 'testing', type: 'test.flaky', payload: {} });
        await events.append({ project, cardId: '0001', stage: 'testing', type: 'test.flaky', payload: {} });

        expect((await events.recent(project)).map(event => event.cardId)).toEqual(['0001']);
    });

    it('abandons a stranded run at boot and answers its batch to send on', async () => {
        const batch = await startBatch(['current', 'current']);
        await runs.claimNext(batch.id);

        const stranded = await runs.abandonStranded();

        expect(stranded).toContainEqual({ id: batch.id, project });
        expect((await runs.runs(batch.id)).map(run => run.status)).toEqual(['abandoned', 'queued']);
    });

    it('still refuses a lease for a card that does not exist', async () => {
        await expect(leases.acquire(`key-${project}`, project, '0404')).rejects.toThrow(/foreign key/);
    });

    it('refuses to remove a fixture a run used', async () => {
        const batch = await startBatch();
        await drain(batch.id);

        await expect(db.deleteFrom('wilson.evalFixtures').where('id', '=', BigInt(fixtureId)).execute()).rejects.toThrow(/foreign key/);
    });
});
