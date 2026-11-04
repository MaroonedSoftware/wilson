import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { RuleJudge, RuleJudgeInput } from '#modules/rules/rule.judge.js';
import { StaticRuleStore } from '#modules/rules/rule.store.js';
import { RulesService } from '#modules/rules/rules.service.js';

const exec = promisify(execFile);
const config = (codeRoot = '/tmp/code') => new StaticBoardConfig('p', codeRoot, '/tmp/wt', '/tmp/run');
const noJudge = {} as RuleJudge;
const service = () => new RulesService(new StaticRuleStore(), noJudge, config());
const body = { id: 'no-raw-sql', statement: 'Queries go through Kysely', paths: ['src/**'] };

describe('RulesService', () => {
    it('defaults a new rule to blocker, and records a message nobody wrote', async () => {
        const rules = new StaticRuleStore();
        await expect(new RulesService(rules, noJudge, config()).create(body)).resolves.toMatchObject({ severity: 'blocker' });
        expect((await rules.revisions(undefined, 1))[0]?.message).toBe('Added no-raw-sql');
    });

    it.each([
        ['400 for a malformed rule', () => service().create({ ...body, paths: [] }), 400],
        ['404 for a change to no rule', () => service().update('nope', { severity: 'concern' }), 404],
        ['404 for removing no rule', () => service().remove('nope', {}), 404],
    ])('answers %s, with the reason', async (_name, call, statusCode) => {
        await expect(call()).rejects.toMatchObject({ statusCode, details: { reason: expect.any(String) } });
    });

    it('answers 409 for an id already taken', async () => {
        const rules = service();
        await rules.create(body);
        await expect(rules.create(body)).rejects.toMatchObject({ statusCode: 409 });
    });

    describe('check', () => {
        /** `main` moved on after `feature` forked, so a two-dot diff would wrongly include main's own change. */
        const repo = async () => {
            const cwd = await mkdtemp(join(tmpdir(), 'rules-check-'));
            const run = (...args: string[]) => exec('git', args, { cwd });
            await run('init', '-q', '-b', 'main');
            await run('config', 'user.email', 'test@example.com');
            await run('config', 'user.name', 'Test');
            await writeFile(join(cwd, 'base.ts'), 'base\n');
            await run('add', '-A');
            await run('commit', '-q', '-m', 'base');
            const fork = (await run('rev-parse', 'HEAD')).stdout.trim();
            await run('checkout', '-q', '-b', 'feature');
            await writeFile(join(cwd, 'feature.ts'), 'feature\n');
            await run('add', '-A');
            await run('commit', '-q', '-m', 'feature');
            const tip = (await run('rev-parse', 'HEAD')).stdout.trim();
            await run('checkout', '-q', 'main');
            await writeFile(join(cwd, 'main.ts'), 'main\n');
            await run('add', '-A');
            await run('commit', '-q', '-m', 'main moved');
            return { cwd, fork, tip };
        };

        it('judges the branch from its merge base, in the code root, and reports what it cost', async () => {
            const { cwd, fork, tip } = await repo();
            const judge = vi.fn(async (_input: RuleJudgeInput) => ({ verdicts: [], usage: { inputTokens: 5 } }));
            const rules = new StaticRuleStore();
            await rules.create('r1', { statement: 's', paths: ['**'], severity: 'blocker' }, 'x');

            const report = await new RulesService(rules, { judge } as unknown as RuleJudge, config(cwd)).check({ branch: 'feature' });

            expect(report).toEqual({ branch: 'feature', mergeBase: fork, verdicts: [], usage: { inputTokens: 5 } });
            expect(judge.mock.calls[0]![0]).toMatchObject({ cwd, range: [fork, tip] });
            expect(judge.mock.calls[0]![0].rules).toHaveLength(1);
        });

        it.each([
            ['an unknown branch', { branch: 'nope' }],
            ['an unknown base', { branch: 'feature', base: 'nope' }],
            ['what would read as a flag', { branch: '--all' }],
        ])('answers 400 for %s', async (_name, request) => {
            const { cwd } = await repo();
            await expect(new RulesService(new StaticRuleStore(), noJudge, config(cwd)).check(request)).rejects.toMatchObject({ statusCode: 400 });
        });

        it('changes nothing on the checkout', async () => {
            const { cwd } = await repo();
            const judge = vi.fn(async () => ({ verdicts: [] }));
            await new RulesService(new StaticRuleStore(), { judge } as unknown as RuleJudge, config(cwd)).check({ branch: 'feature' });
            expect((await exec('git', ['status', '--porcelain'], { cwd })).stdout).toBe('');
            expect((await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim()).toBe('main');
        });
    });
});
