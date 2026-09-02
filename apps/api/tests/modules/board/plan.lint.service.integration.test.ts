import { describe, expect, it } from 'vitest';
import { BoardRepository, type CardVersionSummary } from '#modules/board/board.repository.js';
import { CardNotFoundError } from '#modules/board/postgres.board.repository.js';
import { PlanLintService } from '#modules/board/plan.lint.service.js';
import { sectionsOf, type Card } from '#modules/board/card.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';

/**
 * `plan.lint.service.test.ts` builds its `Card` fixtures by assigning `sections` directly, which
 * proves each check in isolation but never exercises `sectionsOf`/`filesInScope` — the parser that
 * turns an actual plan.md body (headings, bullet markers, inline-code backticks, an HTML comment in
 * `Files in scope`) into the `sections` map `PlanLintService` reads. A card read from Postgres or
 * disk always arrives through that parser, never as a hand-built object, so this file drives the
 * service from a real markdown body instead — the shape every one of this card's own motivating
 * cases (0185, 0186, 0187) actually took.
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

/** A double-quoted YAML flow sequence, safe for entries containing a colon like `pnpm migrate:up`. */
const yamlList = (items: string[]): string => `[${items.map(item => JSON.stringify(item)).join(', ')}]`;

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
 * A plan body shaped the way a real card's is: `##` headings, bullet-marker list items, inline-code
 * backticks, and the `<!-- globs only -->` comment `Files in scope` sections actually carry (see
 * this very card's own plan.md).
 */
const PLAN_BODY = `## Goal

Do the thing.

## Constraints

- The lint must run \`pnpm migrate:up\` in CI, never \`pnpm migrate:create\` by hand.

## Files in scope

<!-- globs only: every non-blank line here is parsed as a pattern -->
- \`apps/api/src/modules/newthing/brand.new.ts\`
- \`apps/api/src/generated/board.ts\`
- \`apps/api/src/modules/board/**\`

## Tasks

- Wire it up in \`board.module.ts\` and run \`pnpm build\`.

## Acceptance criteria

- It works.

## Out of scope

- Everything else.
`;

const parsedCard = (id = 'c1'): Card => ({
    frontmatter: { id, title: 'Realistic plan', stage: 'planning', dependsOn: [], retries: {} },
    body: PLAN_BODY,
    sections: sectionsOf(PLAN_BODY),
});

describe('PlanLintService, driven from a real plan.md-shaped body', () => {
    it('parses Files in scope past its bullet markers, backticks and leading comment, and Tasks/Constraints past their bullet markers', async () => {
        const service = new PlanLintService(
            new OneCardBoardRepository(parsedCard()),
            // `pnpm build` (Tasks) is explicitly permitted; `pnpm migrate:up` (Constraints) is not.
            stageConfig(['pnpm build'], ['apps/api/src/generated/*.ts']),
        );

        const findings = await service.lint('c1');

        // Exactly one command finding: `pnpm migrate:up` is refused, `pnpm migrate:create` is a
        // single quoted span too but the allowlist happens to also refuse it — assert on the one
        // whose reason we know, and that `pnpm build` (permitted, and single-token `board.module.ts`
        // ignored entirely) produced none.
        const commandFindings = findings.filter(f => f.kind === 'command');
        expect(commandFindings.some(f => f.message.includes('pnpm migrate:up') && f.message.includes('applying a migration needs a database'))).toBe(
            true,
        );
        expect(commandFindings.some(f => f.message.includes('pnpm build'))).toBe(false);

        // `Files in scope`: the HTML comment line contributed no entry, the two exact files are
        // reported (bullet marker and backticks stripped correctly, since matching required the
        // literal path with neither), and the glob entry is left alone.
        const exactPathFindings = findings.filter(f => f.kind === 'exactPath');
        expect(exactPathFindings.map(f => f.message).some(m => m.includes('"apps/api/src/modules/newthing/brand.new.ts"'))).toBe(true);
        expect(exactPathFindings.map(f => f.message).some(m => m.includes('"apps/api/src/generated/board.ts"'))).toBe(true);
        expect(exactPathFindings.map(f => f.message).some(m => m.includes('apps/api/src/modules/board/**'))).toBe(false);
        expect(exactPathFindings).toHaveLength(2);

        // The generated-types entry also overlaps `alwaysAllowed`, reported as its own finding kind.
        const alwaysAllowedFindings = findings.filter(f => f.kind === 'alwaysAllowed');
        expect(alwaysAllowedFindings).toHaveLength(1);
        expect(alwaysAllowedFindings[0]!.message).toContain('apps/api/src/generated/*.ts');
    });

    it('widening the allowlist to cover both prescribed migration commands clears every command finding, leaving the scope findings untouched', async () => {
        const service = new PlanLintService(
            new OneCardBoardRepository(parsedCard()),
            stageConfig(['pnpm build', 'pnpm migrate:up', 'pnpm migrate:create'], ['apps/api/src/generated/*.ts']),
        );

        const findings = await service.lint('c1');

        expect(findings.filter(f => f.kind === 'command')).toHaveLength(0);
        expect(findings.filter(f => f.kind === 'exactPath')).toHaveLength(2);
        expect(findings.filter(f => f.kind === 'alwaysAllowed')).toHaveLength(1);
    });
});
