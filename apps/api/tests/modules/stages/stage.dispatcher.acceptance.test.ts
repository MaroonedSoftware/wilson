import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { ImplementingResultSchema, StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { AcceptanceResultSchema, AcceptanceVerifier } from '#modules/stages/acceptance.checks.js';
import type { ScopeDecision } from '#modules/agent/scope.guard.js';
import type { Card } from '#modules/board/card.js';
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

const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: testing
    onFail: implementing
    testCommand: ./fake-test.sh
    testReportPath: report.json
    steps:
      - name: acceptance
        on: enter
        instructions: write the checks
        extraScope: ['**/*.test.ts']
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: merged
    onFail: testing
`;

const FAKE_TEST = `#!/bin/sh
cat > report.json <<JSON
{"numTotalTests":1,"numPassedTests":0,"numFailedTests":1,"numPendingTests":0,"numTodoTests":0,
 "testResults":[{"name":"$PWD/src/thing.test.ts","status":"failed","message":"Cannot find module ./thing.js","assertionResults":[]}]}
JSON
exit 1
`;

/**
 * A lane with an `enter` step, end to end on a real board and tree: the step writes the checks before
 * any code and proves them red, the card stays in its lane with the checks on its plan, and the lane's
 * own run that follows may read them but not change them.
 */
describe('StageDispatcher runs a lane’s enter step before its own run', () => {
    it('writes and locks the checks, then hands the card to the lane’s own run', async () => {
        const base = await mkdtemp(join(tmpdir(), 'stage-dispatcher-acceptance-'));
        const codeRoot = join(base, 'code');
        await mkdir(join(codeRoot, 'src'), { recursive: true });
        await writeFile(join(codeRoot, '.gitignore'), 'report.json\n');
        await writeFile(join(codeRoot, 'fake-test.sh'), FAKE_TEST);
        await chmod(join(codeRoot, 'fake-test.sh'), 0o755);
        await writeFile(join(codeRoot, 'src', 'kept.ts'), 'export const kept = 1;\n');
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
        await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
        await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
        await exec('git', ['add', '-A'], { cwd: codeRoot });
        await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

        const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(base, 'worktrees'), join(base, 'run'));
        const events = new EventLog(db, silentLogger as never);
        const board = new PostgresBoardRepository(config, db, events);
        const worktrees = new WorktreeManager(config, silentLogger as never);
        const seed: Card = {
            frontmatter: { id: '0001', title: 'make a thing', stage: 'implementing', dependsOn: [], retries: {} },
            sections: { 'Files in scope': '- src/thing.ts', 'Acceptance criteria': '- AC1: makes a thing' },
            body: '## Goal\n\nMake a thing.\n\n## Files in scope\n\n- src/thing.ts\n\n## Acceptance criteria\n\n- AC1: makes a thing\n',
        };
        await board.create(seed, 'seed');

        const ran: string[] = [];
        let lockedWrite: ScopeDecision | undefined;
        const agents = new StageAgentMap();
        agents.set('api', {
            run: async ({ stage, context }): Promise<AgentRunOutput> => {
                ran.push(stage.step ?? stage.name);
                if (stage.step === 'acceptance') {
                    await writeFile(join(context.worktreeRoot, 'src', 'thing.test.ts'), "import { thing } from './thing.js';\n");
                    return {
                        result: { summary: 'one check', checks: [{ criterion: 'AC1', file: 'src/thing.test.ts', name: 'makes a thing' }] },
                        truncated: false,
                    };
                }
                lockedWrite = await context.scope.check('src/thing.test.ts');
                await writeFile(join(context.worktreeRoot, 'src', 'thing.ts'), 'export const thing = 1;\n');
                return { result: { summary: 'made it', filesTouched: ['src/thing.ts'] }, truncated: false };
            },
        });
        const verifiers = new StageVerifierMap();
        verifiers.set('acceptance', new AcceptanceVerifier(worktrees));
        verifiers.set('implementing', {
            verify: async ({ worktree }) => ({ passed: true, failures: [], changedPaths: await worktrees.uncommittedPaths(worktree) }),
        });
        const schemas = new StageResultSchemaMap();
        schemas.set('acceptance', AcceptanceResultSchema);
        schemas.set('implementing', ImplementingResultSchema);
        const dispatcher = new StageDispatcher(
            config,
            new StaticStageConfigStore(stagesYaml),
            board,
            worktrees,
            agents,
            verifiers,
            schemas,
            events,
            silentLogger as never,
        );

        const first = await dispatcher.run('0001', 'implementing');
        expect(first.failures).toEqual([]);
        expect(first.transitionedTo).toBe('implementing');
        expect(first.nextStep).toBeUndefined();
        const afterStep = await board.read('0001');
        expect(afterStep.body).toContain('- `AC1`: `src/thing.test.ts` > makes a thing');
        expect(afterStep.frontmatter.retries).toEqual({});

        const second = await dispatcher.run('0001', 'implementing');
        expect(ran).toEqual(['acceptance', 'implementing']);
        expect(lockedWrite).toMatchObject({ allowed: false });
        expect(second.transitionedTo).toBe('testing');
    });
});
