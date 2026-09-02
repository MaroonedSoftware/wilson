import picomatch from 'picomatch';
import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { findStage, StageConfigError, type ProjectStages } from '#modules/stages/stage.config.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import { BoardRepository } from './board.repository.js';
import { CardNotFoundError } from './postgres.board.repository.js';
import { filesInScope, type Card } from './card.js';
import type { LintFinding } from '../../generated/board.js';

/**
 * The stage whose `CommandAllowlist` decides whether a command the plan prescribes would actually
 * run. Every project's board names its first coding stage `implementing` —
 * `BoardBootstrapService`'s own scaffold seeds exactly one stage with this name, and it is the stage
 * card 0185's plan (this check's own motivating case) prescribed `pnpm migrate:create` for. A project
 * whose config carries no such stage has nothing this check can ask, so {@link commandFindings}
 * reports nothing rather than guessing at a different stage's allowlist.
 */
const COMMAND_STAGE = 'implementing';

/** `` `...` `` spans in a section's text, backticks stripped, blank ones dropped. */
const backtickedSpans = (text: string | undefined): string[] => {
    if (!text) return [];
    return [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!.trim()).filter(span => span.length > 0);
};

/** Characters that mean a backticked span is a code reference or a route, not a command a plan meant to prescribe. */
const CODE_SYNTAX = /[(){}[\]<>]/;

/** The first word of a shell command — lowercase, the shape every binary name in this codebase's stage configs takes. */
const COMMAND_HEAD = /^[a-z][a-z0-9_-]*$/;

/**
 * Whether a backticked span reads as a command a plan is telling a stage to run, as opposed to a
 * type name, a file reference (`stage.dispatcher.ts:819`), or a route (`GET /api/cards/{id}/lint`)
 * — the other things Tasks and Constraints prose quotes in backticks just as often. A single token
 * is never a command in this codebase's stage configs (`pnpm build`, `pnpm exec vitest run`); every
 * allowlist entry is at least two, so a lone word is left alone rather than run through the
 * allowlist and reported as refused for no reason a reader could act on.
 */
const looksLikeCommand = (span: string): boolean => {
    if (CODE_SYNTAX.test(span)) return false;
    const tokens = span.split(/\s+/).filter(Boolean);
    return tokens.length >= 2 && COMMAND_HEAD.test(tokens[0]!);
};

/**
 * Every backticked span in `Tasks` and `Constraints` that looks like a command and that
 * {@link COMMAND_STAGE}'s own `CommandAllowlist` — the same class `stage.dispatcher.ts:819` builds
 * for the real run — would refuse. The refusal's `reason` is carried through verbatim: it is what
 * the agent will actually be told at dispatch, and paraphrasing it here would just be a second
 * version of that sentence to keep in sync.
 */
const commandFindings = (card: Card, stages: ProjectStages): LintFinding[] => {
    let allowedCommands: string[];
    try {
        allowedCommands = findStage(stages, COMMAND_STAGE).allowedCommands;
    } catch (err) {
        if (err instanceof StageConfigError) return [];
        throw err;
    }

    const allowlist = new CommandAllowlist(allowedCommands);
    const spans = new Set([...backtickedSpans(card.sections['Tasks']), ...backtickedSpans(card.sections['Constraints'])]);

    const findings: LintFinding[] = [];
    for (const span of spans) {
        if (!looksLikeCommand(span)) continue;
        const decision = allowlist.check(span);
        if (!decision.allowed) {
            findings.push({ kind: 'command', message: `\`${span}\` — ${decision.reason}` });
        }
    }
    return findings;
};

/** Glob metacharacters — the same set `scope.overlap.ts` treats as making a path segment a pattern rather than a literal. */
const GLOB_META = /[*?[\]{}]/;

/**
 * Every `Files in scope` entry that names an exact file rather than a glob — no glob metacharacter
 * anywhere in it, and a last path segment that looks like a filename (it has an extension), not a
 * bare directory a reader would already read as needing `/**` to mean anything. An entry shaped
 * this way cannot widen to cover a sibling the agent ends up creating instead of the one predicted,
 * so this suggests the `dir/**` form that would.
 */
const exactPathFindings = (card: Card): LintFinding[] => {
    const findings: LintFinding[] = [];
    for (const entry of filesInScope(card)) {
        if (GLOB_META.test(entry)) continue;

        const lastSlash = entry.lastIndexOf('/');
        const leaf = lastSlash === -1 ? entry : entry.slice(lastSlash + 1);
        if (!leaf.includes('.')) continue;

        const suggestion = lastSlash === -1 ? '**' : `${entry.slice(0, lastSlash)}/**`;
        findings.push({
            kind: 'exactPath',
            message: `"${entry}" is an exact path, not a glob — if it or its directory does not exist yet, prefer "${suggestion}" so the plan does not have to predict exactly what gets created.`,
        });
    }
    return findings;
};

/**
 * Every `Files in scope` entry that `alwaysAllowed` covers *entirely* — machine-owned paths no plan
 * should have to mention.
 *
 * Subsumption, not overlap, and the distinction is the whole check. This first shipped using
 * `scopeOverlap` (card 0069's pattern-vs-pattern matcher) on the reasoning that "a plan's own entry
 * naming ground `alwaysAllowed` already covers is noise regardless of how much more the entry also
 * reaches". That is backwards. Run against card [[0185]]'s real plan it reported
 * `apps/api/src/modules/context/**` as covered by the snapshot-file pattern on `alwaysAllowed`,
 * because a `.snap` file could live under that directory — so the two patterns do overlap, and the
 * entry is nonetheless carrying an entire module that nothing else permits. Acting on that finding
 * would have broken the card.
 *
 * The test is therefore: does an `alwaysAllowed` pattern match the entry *read as a literal path*?
 * That is sound in the direction that matters. `apps/api/src/generated/context.ts` is matched by
 * `apps/api/src/generated/*.ts` and is genuinely redundant; `packages/sdk/src/types/**` sits under
 * `packages/sdk/src/**` and is too. It is deliberately conservative the other way —
 * `apps/api/src/generated/**` is not reported, because it reaches past the `*.ts` that is exempt —
 * and a check that stays quiet when unsure is worth more here than one that is confidently wrong,
 * since its whole value is that an operator can act on what it says.
 */
const alwaysAllowedFindings = (card: Card, stages: ProjectStages): LintFinding[] => {
    if (stages.alwaysAllowed.length === 0) return [];
    // One matcher per pattern rather than one over the list: the finding names *which* entry on
    // `alwaysAllowed` subsumes the plan's, which is what lets an operator check the claim instead of
    // taking it. `dot: true` matches `ScopeGuard`'s own picomatch options, so this agrees with the
    // guard that enforces the list rather than with a second, subtly different reading of it.
    const matchers = stages.alwaysAllowed.map(pattern => ({ pattern, matches: picomatch(pattern, { dot: true }) }));

    const findings: LintFinding[] = [];
    for (const entry of filesInScope(card)) {
        const covering = matchers.find(({ matches }) => matches(entry));
        if (!covering) continue;
        findings.push({
            kind: 'alwaysAllowed',
            message: `"${entry}" is already covered by alwaysAllowed's "${covering.pattern}" — the runner permits this without the plan declaring it.`,
        });
    }
    return findings;
};

/**
 * Checks a plan against the config the runner will actually enforce, and reports what it finds.
 *
 * The whole argument for building this rather than writing it down as a document: a document
 * drifts from what the runner enforces the first time either one changes without the other, and
 * this session (card 0193's own) found two such drifts in PROJECT.md alone. Every check here asks
 * the same objects the dispatcher itself asks — `CommandAllowlist`, a project's `alwaysAllowed` —
 * rather than carrying its own copy of the rule, so a stage-config edit changes this service's
 * answers with no code change of its own.
 *
 * Pure over its two inputs: nothing here reaches the filesystem or a project's checked-out code, so
 * a test constructs both dependencies directly rather than standing up a database.
 *
 * Reports; does not refuse. `BoardWriteService.approve` calls nothing here — a plan can be
 * legitimately unusual, and a gate that cannot be overridden becomes a reason to route around it
 * (this card's own Constraints).
 */
@Injectable()
export class PlanLintService {
    constructor(
        private readonly boardRepository: BoardRepository,
        private readonly stageConfigs: StageConfigStore,
    ) {}

    async lint(id: string): Promise<LintFinding[]> {
        const card = await this.readOrThrow(id);
        const stages = await this.stageConfigs.load();

        return [...commandFindings(card, stages), ...exactPathFindings(card), ...alwaysAllowedFindings(card, stages)];
    }

    private async readOrThrow(id: string): Promise<Card> {
        try {
            return await this.boardRepository.read(id);
        } catch (err) {
            if (err instanceof CardNotFoundError) throw httpError(404);
            throw err;
        }
    }
}
