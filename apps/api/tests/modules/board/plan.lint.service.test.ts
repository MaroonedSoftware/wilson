import { describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { BoardRepository, type CardVersionSummary, type SplitWrite } from '#modules/board/board.repository.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { PlanLintService } from '#modules/board/plan.lint.service.js';
import type { OverlappingPatterns } from '#modules/board/scope.overlap.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { ProjectStages } from '#modules/stages/stage.config.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';

/**
 * A `BoardRepository` that answers `read` for exactly one card and refuses every other method —
 * `PlanLintService` only ever calls `read`, and a test that reaches for anything else here should
 * fail loudly rather than silently exercising a fake that happens to work.
 */
class OneCardBoardRepository extends BoardRepository {
    constructor(private readonly card: Card) {
        super();
    }

    async read(id: string): Promise<Card> {
        if (id !== this.card.frontmatter.id) throw new CardNotFoundError(`card ${id} does not exist`);
        return this.card;
    }

    async list(): Promise<Card[]> {
        throw new Error('not used in this test');
    }

    async readAt(): Promise<Card> {
        throw new Error('not used in this test');
    }

    async currentVersion(): Promise<string | undefined> {
        throw new Error('not used in this test');
    }

    async versions(): Promise<CardVersionSummary[]> {
        throw new Error('not used in this test');
    }

    async write(): Promise<string> {
        throw new Error('not used in this test');
    }

    async writeWithEvent(): Promise<string> {
        throw new Error('not used in this test');
    }

    async create(): Promise<string> {
        throw new Error('not used in this test');
    }

    async setPosition(): Promise<void> {
        throw new Error('not used in this test');
    }

    async applySplit(): Promise<SplitWrite | undefined> {
        throw new Error('not used in this test');
    }

    async hasLiveClaim(): Promise<boolean> {
        throw new Error('not used in this test');
    }
}

/**
 * Card 0241. `OneCardBoardRepository` plus a controllable `scopeConflict` answer.
 * `BoardRepository.scopeConflict` itself — its `list`/`hasLiveClaim`/live-claim plumbing — is
 * reused unchanged per this card's own Constraints ("do not reimplement the matcher"), so these
 * tests stand in for its answer directly rather than re-proving *its* logic through a second fake
 * board with staged cards; what is actually new here is `PlanLintService` turning that answer into
 * a `LintFinding`.
 */
class ScopeConflictBoardRepository extends OneCardBoardRepository {
    constructor(
        card: Card,
        private readonly answer: (
            events: EventLog,
            project: string,
            card: Card,
            stages: ProjectStages,
        ) => Promise<{ cardId: string; overlap: OverlappingPatterns[] } | undefined>,
    ) {
        super(card);
    }

    async scopeConflict(
        events: EventLog,
        project: string,
        card: Card,
        stages: ProjectStages,
    ): Promise<{ cardId: string; overlap: OverlappingPatterns[] } | undefined> {
        return this.answer(events, project, card, stages);
    }
}

/** A card with just enough shape for `PlanLintService` to read — frontmatter plus the sections it inspects. */
const card = (overrides: { tasks?: string; constraints?: string; filesInScope?: string; acceptanceCriteria?: string }): Card => ({
    frontmatter: { id: 'c1', title: 'Test card', stage: 'planning', dependsOn: [], retries: {} },
    body: '',
    sections: {
        Tasks: overrides.tasks ?? '',
        Constraints: overrides.constraints ?? '',
        'Files in scope': overrides.filesInScope ?? '',
        ...(overrides.acceptanceCriteria !== undefined ? { 'Acceptance criteria': overrides.acceptanceCriteria } : {}),
    },
});

/** A double-quoted YAML flow sequence — safe for entries like `pnpm migrate:up` that a bare block list would risk misreading as a mapping key. */
const yamlList = (items: string[]): string => `[${items.map(item => JSON.stringify(item)).join(', ')}]`;

/** A stage config with one `implementing` stage carrying `allowedCommands`, and the given `alwaysAllowed`. */
const stageConfig = (allowedCommands: string[], alwaysAllowed: string[] = []): StaticStageConfigStore =>
    new StaticStageConfigStore(`
scopeViolation: widen
alwaysAllowed: ${yamlList(alwaysAllowed)}
deny: []
stages:
    - name: implementing
      mode: agent
      model: claude-sonnet-5
      instructions: test
      allowedCommands: ${yamlList(allowedCommands)}
      onPass: merged
      onFail: implementing
`);

/**
 * Card 0241 gave `PlanLintService` two new constructor dependencies (`EventLog`, `BoardConfig`) for
 * `scopeConflictFindings`. Every test below that is not itself about that finding wants the same
 * thing every pre-0241 test already wanted: no `scopeConflict` finding, full stop. `{}` cast as
 * `EventLog` is enough — `BoardRepository.scopeConflict`'s own `cardHistory` call throws reaching
 * for a method this fake does not have, and `scopeConflictFindings` treats that failure as "no
 * finding" (its own doc comment, and the dedicated describe block below), the same as `OneCardBoardRepository`
 * throwing on `list`. `PlanLintService`'s own tests for the new finding construct their `BoardRepository`
 * (`ScopeConflictBoardRepository`) to answer directly instead, bypassing this fallthrough.
 */
const fakeEventLog = {} as unknown as EventLog;
const boardConfig = new StaticBoardConfig('plan-lint-test', '/tmp/code', '/tmp/wt', '/tmp/run');

describe('PlanLintService', () => {
    it('rejects with a 404 for a card that does not exist', async () => {
        const service = new PlanLintService(new OneCardBoardRepository(card({})), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        await expect(service.lint('nope')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('reports a command the runner will refuse, quoting the allowlist’s own reason', async () => {
        const c = card({ tasks: 'Apply the migration: `pnpm migrate:up`.' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const findings = await service.lint('c1');

        expect(findings).toHaveLength(1);
        expect(findings[0]!.kind).toBe('command');
        // The refusal is `CommandAllowlist`'s own reason, carried through — not a paraphrase.
        expect(findings[0]!.message).toContain('applying a migration needs a database');
    });

    it('stops reporting a command once the stage’s own allowlist widens to permit it — proof the check reads config, not a hardcoded list', async () => {
        const c = card({ constraints: 'Only `pnpm migrate:up` fixes this.' });
        const narrow = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);
        const widened = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build', 'pnpm migrate:up']), fakeEventLog, boardConfig);

        expect(await narrow.lint('c1')).toHaveLength(1);
        expect(await widened.lint('c1')).toHaveLength(0);
    });

    it('leaves a single technical term alone — no command shape, nothing to run through the allowlist', async () => {
        const c = card({ constraints: 'Construct `new CommandAllowlist(stage.allowedCommands)` and ask it.' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        expect(await service.lint('c1')).toHaveLength(0);
    });

    it('reports a scope entry alwaysAllowed already covers', async () => {
        const c = card({ filesInScope: 'apps/api/src/generated/board.ts' });
        const service = new PlanLintService(
            new OneCardBoardRepository(c),
            stageConfig([], ['apps/api/src/generated/*.ts']),
            fakeEventLog,
            boardConfig,
        );

        const findings = await service.lint('c1');

        expect(findings.map(f => f.kind)).toContain('alwaysAllowed');
        const finding = findings.find(f => f.kind === 'alwaysAllowed')!;
        expect(finding.message).toContain('apps/api/src/generated/*.ts');
    });

    it('returns no findings for a plan with none of the three problems', async () => {
        const c = card({
            tasks: 'Wire it up in `board.module.ts` and run the build.',
            constraints: 'See `CommandDecision.reason` for the exact wording.',
            filesInScope: 'apps/api/src/modules/board/**',
        });
        const service = new PlanLintService(
            new OneCardBoardRepository(c),
            stageConfig(['pnpm build'], ['pnpm-lock.yaml']),
            fakeEventLog,
            boardConfig,
        );

        expect(await service.lint('c1')).toEqual([]);
    });
});

/**
 * Regression, found by running this service against card 0185's real plan on 2026-09-02 rather than
 * against a fixture. The check first shipped using `scopeOverlap`, on the reasoning that an entry
 * naming ground `alwaysAllowed` covers is noise "regardless of how much more the entry also
 * reaches". Overlap is not subsumption: a `.snap` file *could* live under
 * `apps/api/src/modules/context/`, so the patterns overlap, and the entry is still carrying a whole
 * module that nothing else permits. Acting on that finding would have broken the card.
 *
 * Both cases below fail on the pre-change tree — the first reported, the second reported against
 * the wrong pattern.
 */
describe('PlanLintService alwaysAllowed subsumption', () => {
    it('does not report an entry that merely overlaps a pattern, without being covered by it', async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/context/**' });
        const service = new PlanLintService(
            new OneCardBoardRepository(c),
            stageConfig([], ['**/*.snap', 'packages/sdk/src/**']),
            fakeEventLog,
            boardConfig,
        );

        const findings = await service.lint('c1');

        expect(findings.filter(f => f.kind === 'alwaysAllowed')).toHaveLength(0);
    });

    it('still reports an entry a pattern genuinely subsumes, naming the pattern', async () => {
        const c = card({ filesInScope: 'packages/sdk/src/types/**' });
        const service = new PlanLintService(
            new OneCardBoardRepository(c),
            stageConfig([], ['**/*.snap', 'packages/sdk/src/**']),
            fakeEventLog,
            boardConfig,
        );

        const finding = (await service.lint('c1')).find(f => f.kind === 'alwaysAllowed');

        expect(finding?.message).toContain('packages/sdk/src/**');
    });

    it('stays quiet when an entry reaches past what the pattern exempts', async () => {
        // `apps/api/src/generated/**` includes more than the `*.ts` that is exempt, so the plan is
        // right to declare it. A check that guesses here is worse than one that says nothing.
        const c = card({ filesInScope: 'apps/api/src/generated/**' });
        const service = new PlanLintService(
            new OneCardBoardRepository(c),
            stageConfig([], ['apps/api/src/generated/*.ts']),
            fakeEventLog,
            boardConfig,
        );

        expect((await service.lint('c1')).filter(f => f.kind === 'alwaysAllowed')).toHaveLength(0);
    });
});

/**
 * Regression, found by running this service against card 0185's real plan rather than a fixture.
 * The extractor accepted any backticked span that was multi-token with a lowercase first word, and
 * `id BIGSERIAL PRIMARY KEY` — a column definition quoted in a migration task — satisfies both. It
 * was reported as a command the stage would refuse, which is true and useless.
 *
 * The head must now also be a binary something knows about: one heading an entry on the stage's own
 * allowlist, or one `CommandAllowlist` names itself.
 */
describe('PlanLintService command extraction', () => {
    const prose = (tasks: string) => card({ tasks, filesInScope: 'apps/api/src/modules/board/**' });

    it('does not treat quoted SQL as a command, however command-shaped it looks', async () => {
        const c = prose('Columns: `id BIGSERIAL PRIMARY KEY`, `project TEXT NOT NULL`.');
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        expect(await service.lint('c1')).toHaveLength(0);
    });

    it('still reports a real command the stage would refuse', async () => {
        const c = prose('Run `pnpm migrate:create card_context`, then `pnpm build`.');
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const findings = await service.lint('c1');

        expect(findings).toHaveLength(1);
        expect(findings[0]!.message).toContain('pnpm migrate:create card_context');
    });

    it('recognises a binary CommandAllowlist names even when no allowlist entry heads with it', async () => {
        // `dbmate` heads nothing on the allowlist; the list knows it by name as migration tooling.
        const c = prose('Apply it with `dbmate -d ./data/migrations up`.');
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        expect(await service.lint('c1')).toHaveLength(1);
    });

    it('recognises a head from the stage’s own allowlist, so a project naming other binaries needs no code change', async () => {
        const c = prose('Then `cargo build --release`.');
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['cargo test']), fakeEventLog, boardConfig);

        expect(await service.lint('c1')).toHaveLength(1);
    });
});

/**
 * Regression, found by sweeping the lint across the board's own cards. Card 0187's plan writes
 * `pnpm migrate:*` and `pnpm build|test|lint|install|codegen` when naming groups of commands in
 * prose. Both were reported as refused — accurately, since `CommandAllowlist` refuses anything
 * carrying shell syntax — and uselessly, since neither was ever a command the plan prescribed.
 *
 * A span with a metacharacter cannot be a command a plan means to run, because no such command can
 * run at all. Both cases fail on the pre-change tree.
 */
describe('PlanLintService and shell-syntax prose', () => {
    const prose = (tasks: string) => card({ tasks, filesInScope: 'apps/api/src/modules/board/**' });

    it('ignores a glob used as shorthand for a family of commands', async () => {
        const c = prose('Do not reach for `pnpm migrate:*` — no stage carries it.');
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        expect(await service.lint('c1')).toHaveLength(0);
    });

    it('ignores an alternation used as shorthand for an allowlist', async () => {
        const c = prose('This stage allows `pnpm build|test|lint|install|codegen` and read-only git.');
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        expect(await service.lint('c1')).toHaveLength(0);
    });

    it('still reports a real command, which carries no shell syntax to begin with', async () => {
        const c = prose('Run `pnpm migrate:up` first.');
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        expect(await service.lint('c1')).toHaveLength(1);
    });
});

/**
 * Card 0241. `wilson card lint` and `GET /api/cards/{id}/lint` warning when a plan overlaps a card
 * already in flight — `PlanLintService.lint` now also calls `BoardRepository.scopeConflict` (reused
 * unchanged, per this card's own Constraints) and turns whatever it answers into findings. Every
 * case here fails on the pre-change tree: that call did not exist yet, so `lint` never returned a
 * `scopeConflict` finding no matter what `scopeConflict` itself would have said.
 */
describe('PlanLintService scopeConflict findings', () => {
    // Reuses the module-level `fakeEventLog`/`boardConfig` — here they are genuinely exercised
    // (passed through to `scopeConflict`), not just plugged in to satisfy the constructor.
    it('reports a finding naming both patterns and the other card, quoting the constraint’s own wording', async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/board/**' });
        const answer = vi.fn().mockResolvedValue({
            cardId: '0099',
            overlap: [{ ours: 'apps/api/src/modules/board/**', theirs: 'apps/api/src/**' }] satisfies OverlappingPatterns[],
        });
        const service = new PlanLintService(new ScopeConflictBoardRepository(c, answer), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const findings = await service.lint('c1');

        const conflicts = findings.filter(f => f.kind === 'scopeConflict');
        expect(conflicts).toHaveLength(1);
        // The exact sentence this card's own Constraints prescribe — not a paraphrase.
        expect(conflicts[0]!.message).toBe(
            '"apps/api/src/modules/board/**" overlaps apps/api/src/** on 0099 (in flight): this card will wait for it',
        );
    });

    it('reports one finding per overlapping pattern pair when scopeConflict returns several', async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/board/**' });
        const answer = vi.fn().mockResolvedValue({
            cardId: '0099',
            overlap: [
                { ours: 'apps/api/src/modules/board/**', theirs: 'apps/api/src/**' },
                { ours: 'apps/api/src/modules/board/plan.lint.service.ts', theirs: 'apps/api/src/modules/board/**' },
            ] satisfies OverlappingPatterns[],
        });
        const service = new PlanLintService(new ScopeConflictBoardRepository(c, answer), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const conflicts = (await service.lint('c1')).filter(f => f.kind === 'scopeConflict');

        expect(conflicts.map(f => f.message)).toEqual([
            '"apps/api/src/modules/board/**" overlaps apps/api/src/** on 0099 (in flight): this card will wait for it',
            '"apps/api/src/modules/board/plan.lint.service.ts" overlaps apps/api/src/modules/board/** on 0099 (in flight): this card will wait for it',
        ]);
    });

    it('reports nothing when scopeConflict finds no card in flight to collide with, and leaves the other findings untouched', async () => {
        const c = card({
            filesInScope: 'apps/api/src/modules/board/**',
            tasks: 'Run `pnpm migrate:up` first.',
        });
        const answer = vi.fn().mockResolvedValue(undefined);
        const service = new PlanLintService(new ScopeConflictBoardRepository(c, answer), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const findings = await service.lint('c1');

        expect(findings.filter(f => f.kind === 'scopeConflict')).toHaveLength(0);
        // The command finding a plain `scopeConflict: undefined` has nothing to do with still fires.
        expect(findings.some(f => f.kind === 'command')).toBe(true);
    });

    it('treats a failing scopeConflict as no finding — the same best-effort rule deferOnScopeConflict itself already follows', async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/board/**' });
        const answer = vi.fn().mockRejectedValue(new Error('event log unreachable'));
        const service = new PlanLintService(new ScopeConflictBoardRepository(c, answer), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const findings = await service.lint('c1');

        expect(findings.filter(f => f.kind === 'scopeConflict')).toHaveLength(0);
    });

    it("passes this card's own event log and BoardConfig.project through to scopeConflict, for the card actually being linted", async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/board/**' });
        const answer = vi.fn().mockResolvedValue(undefined);
        const config = new StaticBoardConfig('a-specific-project', '/tmp/code', '/tmp/wt', '/tmp/run');
        const service = new PlanLintService(new ScopeConflictBoardRepository(c, answer), stageConfig(['pnpm build']), fakeEventLog, config);

        await service.lint('c1');

        expect(answer).toHaveBeenCalledTimes(1);
        const [events, project, passedCard] = answer.mock.calls[0]!;
        expect(events).toBe(fakeEventLog);
        expect(project).toBe('a-specific-project');
        expect(passedCard.frontmatter.id).toBe('c1');
    });
});

/**
 * Card 0245. `PlanLintService.lint` now also calls `acceptanceCriteriaFindings`, which runs
 * `acceptanceCriteria(card)` (0236's own parser, reused rather than re-derived) over the plan and
 * reports the two ways it can fail to trace criteria back to a review: two bullets whose explicit ID
 * collides, and an `Acceptance criteria` section with prose but no bullets the parser could find.
 * Every case here fails on the pre-change tree: `acceptanceCriteriaFindings` did not exist yet, so
 * `lint` never returned an `acceptanceCriteria` finding no matter what the section looked like.
 */
describe('PlanLintService acceptanceCriteria findings', () => {
    it('reports duplicate explicit IDs on a plan with two bullets both labelled AC1:', async () => {
        const c = card({
            filesInScope: 'apps/api/src/modules/board/**',
            acceptanceCriteria: '- AC1: first thing works.\n- AC1: second thing also works.',
        });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const findings = await service.lint('c1');

        const criteriaFindings = findings.filter(f => f.kind === 'acceptanceCriteria');
        expect(criteriaFindings).toHaveLength(1);
        expect(criteriaFindings[0]!.message).toContain('AC1');
        expect(criteriaFindings[0]!.message).toContain('2');
    });

    it('reports a section that has text but no bullets the parser can find', async () => {
        // `acceptanceCriteria` treats every non-blank, non-comment line as a bullet — even one with
        // no marker at all (the same rule `filesInScope` follows) — so the only way a non-empty
        // section parses to zero criteria is when everything in it is an HTML comment: text a human
        // reading the plan sees, but nothing `acceptanceCriteria` can turn into a criterion.
        const c = card({
            filesInScope: 'apps/api/src/modules/board/**',
            acceptanceCriteria: '<!-- TODO: fill these in before this leaves planning -->',
        });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        const findings = await service.lint('c1');

        const criteriaFindings = findings.filter(f => f.kind === 'acceptanceCriteria');
        expect(criteriaFindings).toHaveLength(1);
        expect(criteriaFindings[0]!.message).toContain('no bullets');
    });

    it('reports nothing for well-formed criteria, and leaves the existing lint kinds unchanged', async () => {
        const c = card({
            filesInScope: 'apps/api/src/generated/board.ts',
            tasks: 'Run `pnpm migrate:up` first.',
            acceptanceCriteria: '- AC1: first thing works.\n- AC2: second thing also works.',
        });
        const service = new PlanLintService(
            new OneCardBoardRepository(c),
            stageConfig(['pnpm build'], ['apps/api/src/generated/*.ts']),
            fakeEventLog,
            boardConfig,
        );

        const findings = await service.lint('c1');

        expect(findings.filter(f => f.kind === 'acceptanceCriteria')).toHaveLength(0);
        // The other two checks still fire exactly as before — this finding is additive, not a replacement.
        expect(findings.some(f => f.kind === 'command')).toBe(true);
        expect(findings.some(f => f.kind === 'alwaysAllowed')).toBe(true);
    });

    it('stays quiet when the section is empty, positional IDs collide with nothing', async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/board/**' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']), fakeEventLog, boardConfig);

        expect((await service.lint('c1')).filter(f => f.kind === 'acceptanceCriteria')).toHaveLength(0);
    });
});
