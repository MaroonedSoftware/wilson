import { describe, expect, it } from 'vitest';
import { BoardRepository, type CardVersionSummary } from '#modules/board/board.repository.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { PlanLintService } from '#modules/board/plan.lint.service.js';
import type { Card } from '#modules/board/card.js';
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

    async hasLiveClaim(): Promise<boolean> {
        throw new Error('not used in this test');
    }
}

/** A card with just enough shape for `PlanLintService` to read — frontmatter plus the two sections it inspects. */
const card = (overrides: { tasks?: string; constraints?: string; filesInScope?: string }): Card => ({
    frontmatter: { id: 'c1', title: 'Test card', stage: 'planning', dependsOn: [], retries: {} },
    body: '',
    sections: {
        Tasks: overrides.tasks ?? '',
        Constraints: overrides.constraints ?? '',
        'Files in scope': overrides.filesInScope ?? '',
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

describe('PlanLintService', () => {
    it('rejects with a 404 for a card that does not exist', async () => {
        const service = new PlanLintService(new OneCardBoardRepository(card({})), stageConfig(['pnpm build']));

        await expect(service.lint('nope')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('reports a command the runner will refuse, quoting the allowlist’s own reason', async () => {
        const c = card({ tasks: 'Apply the migration: `pnpm migrate:up`.' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']));

        const findings = await service.lint('c1');

        expect(findings).toHaveLength(1);
        expect(findings[0]!.kind).toBe('command');
        // The refusal is `CommandAllowlist`'s own reason, carried through — not a paraphrase.
        expect(findings[0]!.message).toContain('applying a migration needs a database');
    });

    it('stops reporting a command once the stage’s own allowlist widens to permit it — proof the check reads config, not a hardcoded list', async () => {
        const c = card({ constraints: 'Only `pnpm migrate:up` fixes this.' });
        const narrow = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']));
        const widened = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build', 'pnpm migrate:up']));

        expect(await narrow.lint('c1')).toHaveLength(1);
        expect(await widened.lint('c1')).toHaveLength(0);
    });

    it('leaves a single technical term alone — no command shape, nothing to run through the allowlist', async () => {
        const c = card({ constraints: 'Construct `new CommandAllowlist(stage.allowedCommands)` and ask it.' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build']));

        expect(await service.lint('c1')).toHaveLength(0);
    });

    it('reports an exact path where a glob is wanted, suggesting the dir/** form', async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/newthing/brand.new.ts' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig([]));

        const findings = await service.lint('c1');

        expect(findings).toHaveLength(1);
        expect(findings[0]!.kind).toBe('exactPath');
        expect(findings[0]!.message).toContain('apps/api/src/modules/newthing/**');
    });

    it('does not flag a glob entry as an exact path', async () => {
        const c = card({ filesInScope: 'apps/api/src/modules/newthing/**' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig([]));

        expect(await service.lint('c1')).toHaveLength(0);
    });

    it('reports a scope entry alwaysAllowed already covers', async () => {
        const c = card({ filesInScope: 'apps/api/src/generated/board.ts' });
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig([], ['apps/api/src/generated/*.ts']));

        const findings = await service.lint('c1');

        // The literal path also names an exact file (`board.ts` has an extension), so it earns both
        // findings — this asserts the one this test is about is among them.
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
        const service = new PlanLintService(new OneCardBoardRepository(c), stageConfig(['pnpm build'], ['pnpm-lock.yaml']));

        expect(await service.lint('c1')).toEqual([]);
    });
});
