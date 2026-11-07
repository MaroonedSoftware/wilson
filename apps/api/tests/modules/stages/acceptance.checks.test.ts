import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ScopeGuard, LOCKED_REASON } from '#modules/agent/scope.guard.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import {
    acceptanceCheckPaths,
    AcceptanceVerifier,
    enterStep,
    hasAcceptanceChecks,
    isEnterStep,
    withAcceptanceChecks,
} from '#modules/stages/acceptance.checks.js';
import { findStage, StageConfigSchema, type ProjectStages } from '#modules/stages/stage.config.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const card = (body = '## Goal\n\nDo it.\n\n## Acceptance criteria\n\n- AC1: makes a thing\n- AC2: the page looks right\n'): Card => ({
    frontmatter: { id: '0001', title: 't', stage: 'implementing', dependsOn: [], retries: {} },
    sections: { 'Acceptance criteria': '- AC1: makes a thing\n- AC2: the page looks right' },
    body,
});

const lane = StageConfigSchema.parse({
    name: 'implementing',
    mode: 'agent',
    model: 'm',
    instructions: 'i',
    onPass: 'testing',
    onFail: 'implementing',
    testCommand: './fake-test.sh',
    testReportPath: 'report.json',
    steps: [{ name: 'acceptance', on: 'enter', instructions: 'write the checks' }],
});
const stages = { stages: [lane], sandbox: { enabled: false, allowedDomains: [] } } as unknown as ProjectStages;
const step = findStage(stages, 'implementing', 'acceptance');

const RESULT = {
    summary: 'one check',
    checks: [{ criterion: 'AC1', file: 'src/thing.test.ts', name: 'makes a thing' }],
    uncheckable: [{ criterion: 'AC2', reason: 'needs a person to look' }],
};

describe('the acceptance checks section', () => {
    it('is written once the step passes, and read back as the locked files', () => {
        const body = withAcceptanceChecks(card().body, RESULT);

        expect(hasAcceptanceChecks({ ...card(), body })).toBe(true);
        expect(body).toContain('- `AC1`: `src/thing.test.ts` > makes a thing');
        expect(body).toContain('- `AC2`: not checkable by a test: needs a person to look');
        expect(acceptanceCheckPaths(body)).toEqual(['src/thing.test.ts']);
    });

    it('sends a card with no checks to the lane’s enter step, and one with them to the lane’s own run', () => {
        expect(enterStep(findStage(stages, 'implementing'), card())).toBe('acceptance');
        expect(enterStep(findStage(stages, 'implementing'), { ...card(), body: withAcceptanceChecks(card().body, RESULT) })).toBeUndefined();
        expect(enterStep(step, card())).toBeUndefined();
        expect(isEnterStep(step)).toBe(true);
        expect(isEnterStep(findStage(stages, 'implementing'))).toBe(false);
    });
});

describe('ScopeGuard locked paths', () => {
    const guard = new ScopeGuard({ worktreeRoot: tmpdir(), allow: ['src/**'], alwaysAllowed: [], locked: ['src/thing.test.ts'] });

    it('refuses a write and a grant, however wide the scope, and still allows the read', async () => {
        expect(await guard.check('src/thing.test.ts')).toMatchObject({ allowed: false, reason: LOCKED_REASON });
        expect(await guard.grant('src/thing.test.ts')).toMatchObject({ allowed: false, reason: LOCKED_REASON });
        expect(await guard.checkRead('src/thing.test.ts')).toMatchObject({ allowed: true });
        expect(await guard.check('src/thing.ts')).toMatchObject({ allowed: true });
    });
});

/** A "test runner" that writes a vitest-shaped report in which only `src/thing.test.ts > makes a thing` fails. */
const FAKE_TEST = `#!/bin/sh
cat > report.json <<JSON
{"numTotalTests":2,"numPassedTests":1,"numFailedTests":1,"numPendingTests":0,"numTodoTests":0,
 "testResults":[{"name":"$PWD/src/thing.test.ts","status":"failed","assertionResults":[
   {"fullName":"thing makes a thing","status":"failed","failureMessages":["expected 1 to be 2"]},
   {"fullName":"thing already works","status":"passed"}]}]}
JSON
exit 1
`;

const setUp = async () => {
    const base = await mkdtemp(join(tmpdir(), 'acceptance-'));
    const codeRoot = join(base, 'code');
    await mkdir(join(codeRoot, 'src'), { recursive: true });
    const git = (...args: string[]) => exec('git', args, { cwd: codeRoot });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 't');
    await writeFile(join(codeRoot, '.gitignore'), 'report.json\n');
    await writeFile(join(codeRoot, 'fake-test.sh'), FAKE_TEST);
    await chmod(join(codeRoot, 'fake-test.sh'), 0o755);
    await writeFile(join(codeRoot, 'src', 'thing.ts'), 'export const thing = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base');
    const manager = new WorktreeManager(new StaticBoardConfig('test', codeRoot, join(base, 'worktrees'), join(base, 'run')), silentLogger as never);
    const worktree = await manager.create('0001', 'card/0001');
    await writeFile(join(worktree.path, 'src', 'thing.test.ts'), "it('makes a thing', () => {});\n");
    return { manager, worktree };
};

describe('AcceptanceVerifier', () => {
    const verify = async (result: unknown, extra?: (path: string) => Promise<void>) => {
        const { manager, worktree } = await setUp();
        await extra?.(worktree.path);
        return new AcceptanceVerifier(manager).verify({ worktree, stage: step, card: card(), cardId: '0001', scope: {} as ScopeGuard, result });
    };

    it('passes when every criterion is accounted for and every check fails on the code as it is', async () => {
        const outcome = await verify(RESULT);
        expect(outcome.failures).toEqual([]);
        expect(outcome.passed).toBe(true);
    });

    it('fails a check that does not fail, since it cannot tell the change from no change', async () => {
        const outcome = await verify({ ...RESULT, checks: [{ criterion: 'AC1', file: 'src/thing.test.ts', name: 'already works' }] });
        expect(outcome.failures).toEqual([expect.stringContaining('did not fail on the code as it is')]);
    });

    it('fails a criterion with neither a check nor a reason', async () => {
        const outcome = await verify({ ...RESULT, uncheckable: [] });
        expect(outcome.failures).toEqual(['acceptance criterion AC2 has no check and no reason it cannot have one']);
    });

    it('fails a step that wrote anything but tests', async () => {
        const outcome = await verify(RESULT, path => writeFile(join(path, 'src', 'thing.ts'), 'export const thing = 2;\n'));
        expect(outcome.failures).toEqual([expect.stringContaining('also wrote: src/thing.ts')]);
    });

    it('rejects an ID the plan does not have as a fault in the report', async () => {
        const outcome = await verify({ ...RESULT, uncheckable: [...RESULT.uncheckable, { criterion: 'AC9', reason: 'x' }] });
        expect(outcome).toMatchObject({ passed: false, reportRejected: true });
    });
});
