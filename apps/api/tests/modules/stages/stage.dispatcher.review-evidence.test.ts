import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { StageAgentMap, type AgentRunOutput } from '#modules/agent/stage.agent.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import type { DB } from '#modules/data/db.js';
import type { EventLog } from '#modules/events/event.log.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { StageResultSchemaMap } from '#modules/stages/stage.result.js';
import { StageVerifierMap, type StageVerifier } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const exec = promisify(execFile);
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/** The real compiler on a real repo: the whole point is that its output parses and compares. */
const TSC = `${resolve('node_modules/.bin/tsc')} -p tsconfig.json`;
const TSCONFIG = JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, types: [], skipLibCheck: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
    include: ['src'],
});

const lanes = (typecheckCommand: string) => `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    typecheckCommand: ${typecheckCommand}
    onPass: review
    onFail: implementing
  - name: review
    mode: agent
    model: claude-opus
    instructions: review it
    typecheckCommand: ${typecheckCommand}
    onPass: merged
    onFail: implementing
`;

const cardFor = (stage: string): Card => ({
    frontmatter: { id: '0001', title: 'do the thing', stage, branch: 'card/0001', dependsOn: [], retries: {} },
    sections: { 'Files in scope': '- src/**' },
    body: '## Goal\n\nDo the thing.\n\n## Files in scope\n\n- src/**\n',
});

/** A repo holding `base` on main and `branch` on top of it on the card's branch, dispatched through a real `run()`. */
const dispatchOn = async (dispatchStage: string, typecheckCommand: string, base: Record<string, string>, branch: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), 'dispatcher-review-evidence-'));
    const codeRoot = join(root, 'code');
    await mkdir(join(codeRoot, 'src'), { recursive: true });
    const git = (...args: string[]) => exec('git', args, { cwd: codeRoot });
    const commitFiles = async (files: Record<string, string>, message: string) => {
        for (const [path, content] of Object.entries(files)) await writeFile(join(codeRoot, path), content);
        await git('add', '-A');
        await git('commit', '-q', '--allow-empty', '-m', message);
    };
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 't');
    await commitFiles({ 'tsconfig.json': TSCONFIG, 'src/x.ts': 'export const x = 1;\n', ...base }, 'base');
    await git('checkout', '-q', '-b', 'card/0001');
    await commitFiles(branch, 'work');
    await git('checkout', '-q', 'main');

    const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(root, 'worktrees'), join(root, 'run'));
    const events = { append: vi.fn<EventLog['append']>(async () => {}) };
    const board: BoardRepository = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    await board.create(cardFor(dispatchStage), 'initial');

    const agents = new StageAgentMap();
    agents.set('api', {
        run: async (): Promise<AgentRunOutput> => ({ result: { summary: 'looked' }, usage: { inputTokens: 10 }, truncated: false }),
    });
    const verifiers = new StageVerifierMap();
    const verifier: StageVerifier = { verify: async () => ({ passed: true, failures: [], changedPaths: [] }) };
    const resultSchemas = new StageResultSchemaMap();
    for (const name of ['implementing', 'review']) {
        verifiers.set(name, verifier);
        resultSchemas.set(name, {} as never);
    }

    const dispatcher = new StageDispatcher(
        config,
        new StaticStageConfigStore(lanes(typecheckCommand)),
        board,
        new WorktreeManager(config, silentLogger as never),
        agents,
        verifiers,
        resultSchemas,
        events as unknown as EventLog,
        silentLogger as never,
    );
    const result = await dispatcher.run('0001', dispatchStage);
    return { result, plan: await readFile(join(config.runRoot, 'cards', '0001', 'plan.md'), 'utf8'), events };
};

describe('review evidence in the plan', () => {
    it('lists a type error the branch adds, through a real run and real tsc', async () => {
        const { result, plan, events } = await dispatchOn('review', TSC, {}, { 'src/y.ts': 'export const y: number = "not a number";\n' });

        expect(result.passed).toBe(true);
        expect(plan).toContain('## Machine evidence');
        expect(plan).toContain('reports 1 net-new type error against');
        expect(plan).toContain('src/y.ts:1:14 TS2322');
        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'review.evidence', payload: expect.objectContaining({ netNewTypeErrors: 1 }) }),
        );
    }, 60_000);

    it('reports zero net-new when the only type error predates the branch', async () => {
        const { plan } = await dispatchOn(
            'review',
            TSC,
            { 'src/old.ts': 'export const old: number = "already broken";\n' },
            { 'src/x.ts': '\n\nexport const x = 2;\n' },
        );

        expect(plan).toContain('reports 0 net-new type errors against');
        expect(plan).not.toContain('already broken');
    }, 60_000);

    it('gives a lane that does not review none, whatever it configures', async () => {
        const { plan, events } = await dispatchOn('implementing', TSC, {}, { 'src/y.ts': 'export const y: number = "not a number";\n' });

        expect(plan).not.toContain('Machine evidence');
        expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'review.evidence' }));
    }, 60_000);

    it('never stops the stage: a command that cannot run is written down and the review goes ahead', async () => {
        const { result, plan } = await dispatchOn('review', './no-such-checker', {}, { 'src/y.ts': 'export const y = 2;\n' });

        expect(result.passed).toBe(true);
        expect(plan).toContain('Could not compute');
        expect(plan).toContain('## Goal');
    }, 60_000);
});
