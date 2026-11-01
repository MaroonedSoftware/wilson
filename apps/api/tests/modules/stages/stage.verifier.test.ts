import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { StageConfigSchema, assertRoutesResolve, type StageConfig } from '#modules/stages/stage.config.js';
import { stageDefaults } from '#tests/modules/stages/stage.fixture.js';
import type { VerificationInput, VerificationOutcome } from '#modules/stages/stage.verifier.js';
import { StageVerifierMap, checkFormat, type StageVerifier } from '#modules/stages/stage.verifier.js';
import type { Worktree } from '#modules/worktree/worktree.manager.js';

/**
 * The map is the whole seam: `StageDispatcher` resolves a verifier by name and never imports a
 * concrete one. These tests exercise the map directly rather than the dispatcher, because the map
 * is what card 0003's testing verifier plugs into.
 */
describe('StageVerifierMap', () => {
    const fakeVerifier = (outcome: VerificationOutcome): StageVerifier => ({
        verify: async (_input: VerificationInput) => outcome,
    });

    it('resolves a registered verifier by name', async () => {
        const map = new StageVerifierMap();
        const verifier = fakeVerifier({ passed: true, failures: [], changedPaths: ['src/a.ts'] });
        map.set('implementing', verifier);

        const resolved = map.get('implementing');
        expect(resolved).toBe(verifier);
        await expect(resolved?.verify({} as VerificationInput)).resolves.toEqual({ passed: true, failures: [], changedPaths: ['src/a.ts'] });
    });

    it('leaves an unknown verifier name absent, which is the dispatcher’s cue to throw', () => {
        const map = new StageVerifierMap();
        map.set('implementing', fakeVerifier({ passed: true, failures: [], changedPaths: [] }));

        expect(map.get('testing')).toBeUndefined();
    });
});

describe('StageConfigSchema', () => {
    const baseStage = {
        name: 'implementing',
        mode: 'agent' as const,
        model: 'claude-opus',
        instructions: 'do the thing',
        onPass: 'testing',
        onFail: 'needs-human',
    };

    it('parses a stage without a verifier field', () => {
        const parsed = StageConfigSchema.safeParse(baseStage);
        expect(parsed.success).toBe(true);
        expect(parsed.data?.verifier).toBeUndefined();
    });

    // Card 0041: `formatCommand` is new, alongside `buildCommand` and `testCommand` — same shape,
    // same optionality, so a project that never sets it keeps parsing exactly as it did before.
    it('leaves formatCommand undefined when the stage does not configure one', () => {
        const parsed = StageConfigSchema.safeParse(baseStage);
        expect(parsed.success).toBe(true);
        expect(parsed.data?.formatCommand).toBeUndefined();
    });

    it('accepts an explicit formatCommand', () => {
        const parsed = StageConfigSchema.safeParse({ ...baseStage, formatCommand: 'pnpm format:check' });
        expect(parsed.success).toBe(true);
        expect(parsed.data?.formatCommand).toBe('pnpm format:check');
    });
});

describe('assertRoutesResolve', () => {
    const stage = (name: string, onPass: string, onFail: string) => ({
        ...stageDefaults,
        name,
        mode: 'agent' as const,
        worktree: 'rw' as const,
        worktreeFrom: 'base' as const,
        extraScope: [],
        provider: 'anthropic' as const,
        model: 'm',
        instructions: '',
        allowedCommands: [],
        maxSteps: 10,
        maxOutputTokens: 1024,
        onPass,
        onFail,
        maxKickbacks: 3,
        baselineCheck: true,
    });
    const config = (...stages: ReturnType<typeof stage>[]) => ({
        scopeViolation: 'widen' as const,
        alwaysAllowed: [],
        deny: [],
        sandbox: { enabled: false, allowedDomains: [] },
        stages,
    });

    it('accepts a route to another configured stage', () => {
        expect(() => assertRoutesResolve(config(stage('a', 'b', 'a'), stage('b', 'merged', 'a')))).not.toThrow();
    });

    it('accepts a route to a terminal state', () => {
        expect(() => assertRoutesResolve(config(stage('a', 'merged', 'dropped')))).not.toThrow();
    });

    it('rejects a route to a stage nobody built, naming it', () => {
        // Card 0011 found this by being stranded: implementing.onFail was `planning`, the transition
        // was written exactly as configured, and the card landed where nothing dispatches.
        expect(() => assertRoutesResolve(config(stage('implementing', 'testing', 'planning')), 'stages.yaml')).toThrow(
            /implementing\.onFail → "planning"/,
        );
    });

    it('lists the valid targets so the fix is obvious', () => {
        expect(() => assertRoutesResolve(config(stage('a', 'nowhere', 'a')))).toThrow(/Valid targets:.*merged/);
    });

    // Card 0055: `needs-human` used to be a terminal lane in `NON_STAGE_STATES`, so a route to it
    // resolved. It is a flag on the card now, not a place anything moves to, so a `stages.yaml` that
    // still names it as an `onFail`/`onPass` target must fail to load exactly like a route to any
    // other nonexistent state.
    it('rejects a route to needs-human, now that the flag replaces the lane rather than naming it', () => {
        expect(() => assertRoutesResolve(config(stage('implementing', 'testing', 'needs-human')))).toThrow(/implementing\.onFail → "needs-human"/);
    });
});

describe('scope is judged on the stage’s own writes', () => {
    // `changedPaths` measures from the fork point, so on a resumed branch it carries every earlier
    // stage's work. Card 0014 kicked back from testing to implementing and then failed three times
    // on test files the testing stage had every right to add — escalating to needs-human over a
    // rule rather than over the work.
    it('distinguishes what the card changed from what this stage wrote', async () => {
        const cardWide = ['src/runner/a.ts', 'apps/api/tests/b.test.ts'];
        const thisStage = ['src/runner/a.ts'];

        // The card's diff contains a path the current stage's scope excludes...
        expect(cardWide).toContain('apps/api/tests/b.test.ts');
        // ...but this stage wrote none of it, so it must not be held to it.
        expect(thisStage).not.toContain('apps/api/tests/b.test.ts');
    });
});

const worktreeAt = (path: string): Worktree => ({ path, branch: 'card/0041-thing', baseSha: 'deadbeef' });

/**
 * Card 0041: formatting is now an exit condition (`checkFormat`), shared by every verifier whose
 * stage may write code, rather than a habit an agent's instructions merely ask for. `checkFormat`
 * itself is deliberately thin — run the configured command, report its own failure — so these
 * tests exercise it against a real subprocess (a plain node script for the pass/fail shape) rather
 * than mocking `runConfiguredCommand`, which would only prove the test agrees with itself about
 * what a failure looks like.
 */
describe('checkFormat', () => {
    let scratchDir: string;

    afterEach(async () => {
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
    });

    it('runs no check at all when formatCommand is not configured', async () => {
        const failures = await checkFormat(worktreeAt(tmpdir()), {} as StageConfig);
        expect(failures).toEqual([]);
    });

    it('reports no failure when the configured command exits zero', async () => {
        scratchDir = await mkdtemp(join(tmpdir(), 'checkformat-ok-'));
        const script = join(scratchDir, 'ok.js');
        await writeFile(script, 'process.exit(0);\n', 'utf8');

        const failures = await checkFormat(worktreeAt(scratchDir), { formatCommand: `node ${script}` } as StageConfig);
        expect(failures).toEqual([]);
    });

    it('surfaces the command’s own failure, naming what it printed, when it exits non-zero', async () => {
        scratchDir = await mkdtemp(join(tmpdir(), 'checkformat-fail-'));
        const script = join(scratchDir, 'fail.js');
        await writeFile(script, "console.error('would reformat src/thing.ts'); process.exit(1);\n", 'utf8');

        const failures = await checkFormat(worktreeAt(scratchDir), { formatCommand: `node ${script}` } as StageConfig);

        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('would reformat src/thing.ts');
    });

    it('runs in the worktree it is given, not wherever the process happens to be', async () => {
        scratchDir = await mkdtemp(join(tmpdir(), 'checkformat-cwd-'));
        // A script that fails unless it is actually running with the worktree as its cwd — proof
        // `checkFormat` passes the worktree path through rather than defaulting somewhere else.
        // Compares realpaths: macOS resolves the tmp dir through a `/private` symlink, so the
        // process's cwd and the path this test wrote the script to are not literally equal strings.
        const script = join(scratchDir, 'cwd.js');
        await writeFile(
            script,
            [
                'const fs = require("node:fs");',
                `const expected = fs.realpathSync(${JSON.stringify(scratchDir)});`,
                'const actual = fs.realpathSync(process.cwd());',
                'if (actual !== expected) { console.error(`wrong cwd: ${actual}`); process.exit(1); }',
                'process.exit(0);',
            ].join('\n'),
            'utf8',
        );

        const failures = await checkFormat(worktreeAt(scratchDir), { formatCommand: `node ${script}` } as StageConfig);
        expect(failures).toEqual([]);
    });
});

/**
 * Card 0041's plan named three constraints for `.prettierignore` specifically: it must not break
 * on ContractKit's `.ck` files, it must exempt the three files already unformatted on main rather
 * than reformat them wholesale, and it must still catch a genuinely unformatted file. This runs
 * the repo's real `prettier` binary against a copy of the repo's real `.prettierignore` — the
 * actual file this card's diff touches — rather than asserting on its text, since the constraint
 * that matters is what prettier does when handed it, not what the file happens to say.
 */
describe('.prettierignore — the format gate’s exemptions (card 0041)', () => {
    let scratchDir: string;
    let prettierBin: string;

    afterEach(async () => {
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
    });

    it('does not break on a ContractKit .ck file, leaves the three pre-existing exemptions alone, and still catches a genuinely unformatted file', async () => {
        const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
        prettierBin = join(repoRoot, 'node_modules', '.bin', 'prettier');
        const ignoreContents = await readFile(join(repoRoot, '.prettierignore'), 'utf8');

        scratchDir = await mkdtemp(join(tmpdir(), 'prettierignore-gate-'));
        await writeFile(join(scratchDir, '.prettierignore'), ignoreContents, 'utf8');

        await mkdir(join(scratchDir, 'contracts'), { recursive: true });
        // ContractKit's own DSL — not JSON, YAML, or anything prettier has a parser for.
        await writeFile(join(scratchDir, 'contracts', 'board.ck'), 'card "board" {{{ not parseable\n', 'utf8');

        await mkdir(join(scratchDir, 'apps', 'api', 'tests'), { recursive: true });
        await writeFile(join(scratchDir, 'apps', 'api', 'tests', 'README.md'), '#uneven   heading\n\n\n\n', 'utf8');
        await mkdir(join(scratchDir, 'brand'), { recursive: true });
        await writeFile(join(scratchDir, 'brand', 'README.md'), '#uneven   heading\n\n\n\n', 'utf8');
        await writeFile(join(scratchDir, 'pnpm-workspace.yaml'), 'packages:\n  -    "apps/*"\n', 'utf8');

        // A file the gate should still catch: nothing here exempts it.
        await writeFile(join(scratchDir, 'unformatted.ts'), 'const x = {a:1,   b :2}\n', 'utf8');

        const failures = await checkFormat(worktreeAt(scratchDir), { formatCommand: `${prettierBin} --check .` } as StageConfig);

        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('unformatted.ts');
        expect(failures[0]).not.toContain('.ck');
        expect(failures[0]).not.toContain('README.md');
        expect(failures[0]).not.toContain('pnpm-workspace.yaml');
    });
});
