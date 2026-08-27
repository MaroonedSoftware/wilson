import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Card 0088 is comments-and-prose only — the plan is explicit that no allowlist gains or loses a
 * command and no guard changes what it permits, so there is no runtime behavior here to exercise.
 * What changed is that three places now say plainly what card 0083 demonstrated: the allowlist
 * stops a shell by habit, not by force, and `ScopeGuard` only ever watched the write tools. These
 * tests read the source text directly, the same way `kickback.onfail-reasoning.test.ts` does for a
 * prior doc-only card. Against the pre-change tree none of this text exists, so every assertion
 * below fails there.
 *
 * Whitespace is collapsed before matching because these comments and PROJECT.md both wrap at a
 * column width that splits several of the sentences being checked across source lines. The source
 * files are JSDoc-style block comments, so each wrapped line also carries a leading `*` that has to
 * come out first — otherwise it survives as a literal character in the middle of a sentence.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string): string => readFileSync(join(here, relativePath), 'utf8');
const normalize = (text: string): string =>
    text
        .replace(/^[ \t]*\*[ \t]?/gm, ' ')
        .replace(/\s+/g, ' ')
        .trim();

describe('card 0088 — the allowlist and ScopeGuard say what they actually guard', () => {
    it('states atop command.allowlist.ts that it is a guardrail against accident and habit, not a security boundary', () => {
        const source = normalize(read('../../../src/modules/agent/command.allowlist.ts'));

        expect(source).toContain('This is a guardrail against accident and habit, not a security boundary.');
    });

    it('narrows the "every stage" claim on command.allowlist.ts to stages that build or test code, naming scope-check as the read-only counterexample', () => {
        const source = normalize(read('../../../src/modules/agent/command.allowlist.ts'));

        expect(source).toContain(
            'command sits on the allowlist of every stage whose job is to build or test code — not a read-only stage like `scope-check`, which carries no allowed commands at all.',
        );
        // The old, overreaching claim this replaced must not come back.
        expect(source).not.toContain('command is on every stage’s allowlist');
        expect(source).not.toContain("command is on every stage's allowlist");
    });

    it('backs the scope-check claim with real behavior: a stage that declares no allowedCommands parses to an empty list, not "every command"', async () => {
        const { StageConfigSchema } = await import('../../../src/modules/stages/stage.config.js');

        const scopeCheck = StageConfigSchema.parse({
            name: 'scope-check',
            mode: 'agent',
            model: 'claude-opus',
            instructions: 'check the scope',
            onPass: 'implementing',
            onFail: 'backlog',
            // allowedCommands deliberately omitted, exactly as the real scope-check stage does.
        });

        expect(scopeCheck.allowedCommands).toEqual([]);
    });

    it('explains on command.allowlist.ts why a command that runs project code defeats the list, citing card 0083 as the worked example', () => {
        const source = normalize(read('../../../src/modules/agent/command.allowlist.ts'));

        expect(source).toContain(
            "Card 0083's agent needed to query the database and delete two files; neither had a tool yet, so it wrote both into a throwaway vitest file and ran it with the one allowed command that would execute anything",
        );
        expect(source).toContain('not a bypass of this list, but the list working as designed');
    });

    it('notes on command.allowlist.ts that card 0086 gave deletes a proper tool without changing the underlying property', () => {
        const source = normalize(read('../../../src/modules/agent/command.allowlist.ts'));

        expect(source).toContain('Card 0086 has since given deletes a proper tool, which closes that one instance without changing the property');
    });

    it('cross-references ScopeGuard from command.allowlist.ts as sharing the same write-tools-only limit', () => {
        const source = normalize(read('../../../src/modules/agent/command.allowlist.ts'));

        expect(source).toContain('`ScopeGuard` (`scope.guard.ts`) is the real constraint on what an agent can change');
        expect(source).toContain('it guards the write tools, not the process');
    });

    it('states on ScopeGuard that it guards the write tools, not the process', () => {
        const source = normalize(read('../../../src/modules/agent/scope.guard.ts'));

        expect(source).toContain(
            "This is the single enforcement point for scope, for the write tools: `write`, `edit` and `delete` all call through here before touching disk, so a write outside scope fails at the tool and the diff can never contain one in the first place. It guards those tools, not the process.",
        );
    });

    it('names the concrete gap on ScopeGuard: a test file writing through fs never calls check()', () => {
        const source = normalize(read('../../../src/modules/agent/scope.guard.ts'));

        expect(source).toContain(
            "A command from a stage's allowlist that runs project code — `pnpm build`, `pnpm test`, `pnpm exec vitest run` — never calls `check`; a test file calling `fs.writeFile` reaches the filesystem directly, unchecked by anything here.",
        );
    });

    it('points from ScopeGuard back to the guardrail-vs-boundary note on command.allowlist.ts', () => {
        const source = normalize(read('../../../src/modules/agent/scope.guard.ts'));

        expect(source).toContain('See the guardrail-vs-boundary note atop `command.allowlist.ts` for why that gap is accepted rather than closed.');
    });

    it('names the consequence for secrets on command.allowlist.ts, connecting it to card 0045 scrubbing the runner env', () => {
        const source = normalize(read('../../../src/modules/agent/command.allowlist.ts'));

        expect(source).toContain(
            'The sharpest cost of mistaking this list for a boundary is credentials, not files: whatever env an allowed command inherits is reachable by whatever project code it runs, allowlist or not',
        );
        expect(source).toContain('Card 0045 scrubs the runner\'s git credentials and provider API keys out of that env for exactly this reason.');
        expect(source).toContain('Restoring an inherited env because "the allowlist already covers what a command can reach" would undo that.');
    });

    it("distinguishes in PROJECT.md's decision 8 what actually enforces the machinery boundary from what merely discourages tampering with it", () => {
        const projectMd = normalize(read('../../../../../PROJECT.md'));

        expect(projectMd).toContain('What actually enforces that differs by path.');
        expect(projectMd).toContain('The board is unreachable from a worktree by construction (decision 6)');
        expect(projectMd).toContain(
            "`.runner/**` and `**/stages.yaml` are enforced by `ScopeGuard`'s `ALWAYS_DENIED` list, which `request_scope` cannot widen (`scope.guard.ts`) — but only against the write tools",
        );
        expect(projectMd).toContain('see the guardrail-vs-boundary note atop `command.allowlist.ts` for why that stops the write tool and not a command that runs project code');
    });

    it('says in PROJECT.md that materializing the plan outside the worktree only discourages tampering, and why', () => {
        const projectMd = normalize(read('../../../../../PROJECT.md'));

        expect(projectMd).toContain(
            "The plan is materialized outside the worktree at dispatch precisely so it cannot land on the card's branch, but that only discourages tampering with it: the write tool refuses it because the path resolves outside the worktree root, not because anything names and denies that specific path, and a command running project code is bounded by neither check.",
        );
    });
});
