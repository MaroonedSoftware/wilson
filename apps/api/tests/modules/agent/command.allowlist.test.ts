import { describe, expect, it } from 'vitest';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';

/**
 * The allowlist matches argv, not strings. Every case below is one where a prefix check on the raw
 * command would have said yes.
 */
describe('CommandAllowlist', () => {
    const list = new CommandAllowlist(['pnpm build', 'pnpm test', 'git status']);

    it('allows an exact allowlisted command', () => {
        expect(list.check('pnpm build')).toMatchObject({ allowed: true, argv: ['pnpm', 'build'] });
    });

    it('allows extra arguments after an allowlisted prefix', () => {
        expect(list.check('pnpm test --run')).toMatchObject({ allowed: true, argv: ['pnpm', 'test', '--run'] });
    });

    it('normalises repeated whitespace', () => {
        expect(list.check('  pnpm   build  ')).toMatchObject({ allowed: true, argv: ['pnpm', 'build'] });
    });

    it('refuses a command that is not on the list', () => {
        expect(list.check('curl https://example.com')).toMatchObject({ allowed: false });
    });

    describe('actionable refusals', () => {
        // A refusal that only says no gets retried in variants. Card 0001 spent four calls on
        // `find /` before giving up and guessing at the contract.
        it.each([
            ['find . -name "*.ts"', 'glob tool'],
            ['ls node_modules', 'glob tool'],
            ['cat src/index.ts', 'read tool'],
            ['head -20 src/index.ts', 'read tool'],
            ['grep -rn foo src', 'grep tool'],
            ['rg foo', 'grep tool'],
            ['sed -i s/a/b/ f.ts', 'edit tool'],
            ['mkdir -p src/new', 'write tool'],
        ])('points %s at the tool that replaces it', (command, expected) => {
            const decision = list.check(command);
            expect(decision.allowed).toBe(false);
            expect((decision as { reason: string }).reason).toContain(expected);
        });

        it('names the allowlist when there is no tool equivalent', () => {
            const decision = list.check('curl https://example.com');
            expect((decision as { reason: string }).reason).toContain('pnpm build');
        });

        it('suggests the tool even when the command also carries shell syntax', () => {
            // `find / ... 2>/dev/null | head` trips the metacharacter check first; without this the
            // agent is told about the shell and learns nothing about glob.
            const decision = list.check('find / -name johnny5 2>/dev/null | head -20');
            expect((decision as { reason: string }).reason).toContain('glob tool');
        });
    });

    it('refuses a command whose first token merely starts with an allowed one', () => {
        // `pnpmx` is not `pnpm`; token equality, not string prefix.
        expect(list.check('pnpmx build')).toMatchObject({ allowed: false });
    });

    it.each([
        ['pnpm test; rm -rf /', 'chaining with ;'],
        ['pnpm test && curl evil.sh', 'chaining with &&'],
        ['pnpm test | sh', 'piping'],
        ['pnpm test > /etc/passwd', 'redirecting'],
        ['pnpm test $(whoami)', 'command substitution'],
        ['pnpm test `whoami`', 'backtick substitution'],
        ['pnpm test\nrm -rf /', 'a newline'],
        ['pnpm test &', 'backgrounding'],
    ])('refuses %s (%s), because there is no shell to interpret it', command => {
        const decision = list.check(command);
        expect(decision.allowed).toBe(false);
        expect((decision as { reason: string }).reason).toContain('shell');
    });

    it('refuses an empty command', () => {
        expect(list.check('   ')).toMatchObject({ allowed: false });
    });

    it('refuses everything when the allowlist is empty', () => {
        expect(new CommandAllowlist([]).check('pnpm build')).toMatchObject({ allowed: false });
    });
});

/**
 * Card 0048: the subset test command (`pnpm exec vitest run <repo-relative path>`) already works
 * once it's on a stage's allowlist — the gap was that a refused agent reaching for the habitual
 * `pnpm --filter`/`pnpm exec vitest` spellings was only ever told "no", not what would have worked.
 */
describe('CommandAllowlist subset-test suggestions', () => {
    const withVitestRun = new CommandAllowlist(['pnpm build', 'pnpm exec vitest run']);
    const withoutVitestRun = new CommandAllowlist(['pnpm build', 'pnpm test']);

    it.each([
        ['pnpm --filter @wilson/api exec vitest run tests/foo.test.ts', 'pnpm --filter reaching for a package test run'],
        ['pnpm --filter @wilson/api test', 'pnpm --filter with a bare test script'],
        ['pnpm vitest run tests/foo.test.ts', 'pnpm vitest without exec'],
        ['vitest run tests/foo.test.ts', 'bare vitest'],
    ])('names the working form for %s (%s), when the stage allows it', command => {
        const decision = withVitestRun.check(command);
        expect(decision.allowed).toBe(false);
        const reason = (decision as { reason: string }).reason;
        // These phrases only appear in the subset-test suggestion, not in the generic "not on the
        // allowlist" refusal (whose "Allowed: ..." list would otherwise also mention the command
        // string "pnpm exec vitest run" and produce a false pass against a looser assertion).
        expect(reason).toContain('use pnpm exec vitest run <path> instead');
        expect(reason).toContain('repo root');
        expect(reason).toContain('vitest.config.mts');
    });

    it('gets no suggestion naming pnpm exec vitest run when this stage cannot run it', () => {
        const decision = withoutVitestRun.check('pnpm --filter @wilson/api exec vitest run tests/foo.test.ts');
        expect(decision.allowed).toBe(false);
        const reason = (decision as { reason: string }).reason;
        expect(reason).not.toContain('use pnpm exec vitest run <path> instead');
        expect(reason).toContain("not in this stage's allowlist");
    });

    it('does not suggest a test runner for an ordinary pnpm --filter build', () => {
        const decision = withVitestRun.check('pnpm --filter @wilson/api build');
        expect(decision.allowed).toBe(false);
        // The allowlist itself lists "pnpm exec vitest run" among what's allowed, so a bare
        // `.not.toContain('vitest')` would false-pass on the generic refusal text too — assert
        // against the suggestion sentence specifically.
        expect((decision as { reason: string }).reason).not.toContain('use pnpm exec vitest run <path> instead');
    });

    it('gives pnpm add the generic refusal, not a test-runner suggestion', () => {
        const decision = withVitestRun.check('pnpm add left-pad');
        expect(decision.allowed).toBe(false);
        const reason = (decision as { reason: string }).reason;
        expect(reason).not.toContain('use pnpm exec vitest run <path> instead');
        expect(reason).toContain("not in this stage's allowlist");
    });
});

/**
 * Card 0048: a glob is a shell metacharacter and gets refused before the allowlist is even
 * consulted; that refusal should say plain paths work when the command looks like it was reaching
 * for test files.
 */
describe('CommandAllowlist glob refusal note', () => {
    const list = new CommandAllowlist(['pnpm exec vitest run']);

    it('tells the agent plain paths are accepted for a glob over a test path', () => {
        const decision = list.check('pnpm exec vitest run tests/**/*.test.ts');
        expect(decision.allowed).toBe(false);
        expect((decision as { reason: string }).reason).toContain('Plain paths are accepted');
    });

    it('does not add the plain-paths note for a glob that is not a test path', () => {
        const decision = list.check('pnpm exec vitest run src/*.ts');
        expect(decision.allowed).toBe(false);
        expect((decision as { reason: string }).reason).not.toContain('Plain paths are accepted');
    });

    it('does not add the plain-paths note when the command globs and also chains', () => {
        const decision = list.check('pnpm exec vitest run tests/*.test.ts; rm -rf /');
        expect(decision.allowed).toBe(false);
        expect((decision as { reason: string }).reason).not.toContain('Plain paths are accepted');
    });
});
