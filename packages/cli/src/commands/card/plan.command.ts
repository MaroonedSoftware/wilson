import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { PromptCancelledError, prompts, unwrap } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import {
    BoardConfig,
    BoardRepository,
    PLAN_SECTIONS,
    WorktreeManager,
    filesInScope,
    findStage,
    loadStages,
    sectionsOf,
    subscriptionEnv,
    type Card,
} from '@wilson/api/cli-bootstrap';
import { runInteractive } from './editor.js';

/**
 * Plan a card: an interactive conversation with an agent that can read the repo, ending in a plan a
 * person approved.
 *
 * `CliStageAgent` drives `query()` headlessly — no TUI, no operator stdin, and no way to host a
 * conversation. This command spawns the `claude` binary itself with `stdio: 'inherit'`, the same way
 * `editor.ts` spawns `$EDITOR`, and hands the terminal to it for the whole session.
 *
 * The plan comes back through a scratch file, not an MCP tool: `createSdkMcpServer` is in-process to
 * `query()` and unreachable from a spawned binary, and standing up a second `wilson` subcommand behind
 * `--mcp-config` is a lot of new surface for what a file already does. The scratch file also puts the
 * board write behind an explicit human confirmation, which is what "approval is explicit and
 * versioned" asks for.
 *
 * The worktree the agent reads from is a throwaway: a fresh cut of the code repo at HEAD, on a branch
 * that is neither the card's real branch nor at the card's real worktree path, torn down when the
 * session ends either way. Writes inside it are denied by a `--settings` deny list; the draft file,
 * which lives outside the worktree, is the one thing allowed. That is weaker than `ScopeGuard` — it is
 * a settings file read by a spawned process, not enforced by this process — but the worktree is
 * discarded regardless of what happened to it, so nothing written there survives either way.
 */
const command: CommandModule = {
    description: 'Plan a card in an interactive session with an agent that can read the repo, ending in a written plan',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: requireContainer(async (_opts, ctx, args) => {
        const cardId = String(args[0]);
        const config = ctx.container.get(BoardConfig);
        const board = ctx.container.get(BoardRepository);
        const worktrees = ctx.container.get(WorktreeManager);

        // Guard first. The lane is what says this card is being planned; a card with code already on
        // its branch is a different and more dangerous thing to re-plan, so that is refused too,
        // before anything is touched.
        const card = await board.read(cardId);
        if (card.frontmatter.stage !== 'planning') {
            ctx.logger.error(
                `${cardId} is in stage "${card.frontmatter.stage}", not "planning" — move it there first: wilson card move ${cardId} planning`,
            );
            return 1;
        }

        const cardBranch = worktrees.branchName(cardId, card.frontmatter.title);
        if (await worktrees.hasWork(cardBranch)) {
            ctx.logger.error(`${cardId} already has work on ${cardBranch} — re-planning a card with code is a different, more dangerous operation`);
            return 1;
        }

        // Config, not a string in this file: the stage's model and its planning instructions live in
        // stages.yaml like every other stage's do.
        const stages = await loadStages(config.boardRoot);
        const stage = findStage(stages, 'planning');

        // A path that is not worktreeRoot/<cardId> and a branch that is not the card's — `create` and
        // `reclaim` are keyed on whatever string is passed as the card id, so a synthetic one buys a
        // wholly separate tree without touching the card's real worktree or branch at all.
        const planId = `plan-${cardId}`;
        const planBranch = `wilson-plan/${cardId}`;

        // Seeded beside where a running stage's plan.md lands, per `materializePlan` — this is that
        // same directory, before the plan exists.
        const draftDir = join(config.runRoot, 'cards', cardId);
        await mkdir(draftDir, { recursive: true });
        const draftPath = join(draftDir, 'draft.md');

        const hasSections = Object.keys(sectionsOf(card.body)).length > 0;
        const seed = hasSections ? card.body : SKELETON;
        await writeFile(draftPath, seed, 'utf8');

        try {
            const worktree = await worktrees.create(planId, planBranch);

            const initialPrompt = [
                `Card ${cardId}: ${card.frontmatter.title}`,
                '',
                `You are in a fresh worktree of the code repo at ${worktree.path}, cut from HEAD for this`,
                `planning session only — it is not the card's real branch, and nothing written here survives`,
                `past this session. Read whatever you need here to write an informed plan.`,
            ].join('\n');

            // The stage's own instructions, plus the one fact only this command knows: where the
            // draft lives. Both travel as one appended system prompt so the model sees them with the
            // same weight it gives its base instructions, not as a user turn it might treat as
            // negotiable.
            const appendedPrompt = [
                stage.instructions,
                '',
                `Write the finished plan to ${draftPath} — that file, and only that file, is how the plan is`,
                `delivered. It currently holds ${hasSections ? "this card's existing body" : 'an empty six-heading skeleton'}; read it before anything else.`,
            ].join('\n');

            // A settings deny list in a spawned process, not `ScopeGuard` — weaker, and dependent on
            // the installed `claude` version's settings schema. It does not make the worktree
            // read-only; it denies Edit there and allows it on the one file outside the worktree that
            // matters, and the worktree is discarded either way.
            const settings = {
                permissions: {
                    deny: [`Edit(${worktree.path}/**)`],
                    allow: [`Edit(${draftPath})`],
                },
            };

            await runInteractive(
                'claude',
                [
                    initialPrompt,
                    '--model',
                    stage.model,
                    '--append-system-prompt',
                    appendedPrompt,
                    '--add-dir',
                    draftDir,
                    '--settings',
                    JSON.stringify(settings),
                    // Never 'plan': plan mode blocks the very write this command depends on, and its
                    // exit path hands the agent permission to start implementing — the one thing a
                    // planning session must not do.
                    '--permission-mode',
                    'default',
                ],
                { cwd: worktree.path, env: subscriptionEnv() },
            );

            const draftBody = await readFile(draftPath, 'utf8');
            const sections = sectionsOf(draftBody);
            const draftCard: Card = { frontmatter: card.frontmatter, sections, body: draftBody };

            // Refuse an incomplete plan rather than write it — a plan missing a heading, or with an
            // empty "Files in scope", fails at `assertDispatchable` much later with a worse error.
            const missing = PLAN_SECTIONS.filter(section => !sections[section] || sections[section]!.trim().length === 0);
            if (missing.length > 0) {
                ctx.logger.error(`draft is incomplete — empty section(s): ${missing.join(', ')}. Nothing written.`);
                return 1;
            }
            if (filesInScope(draftCard).length === 0) {
                ctx.logger.error('draft has an empty "Files in scope". Nothing written.');
                return 1;
            }

            if (draftBody === card.body) {
                ctx.logger.info('draft is unchanged. Nothing written.');
                return 0;
            }

            ctx.logger.info(`\n${cardId}: ${card.frontmatter.title}\n`);
            for (const line of diffLines(card.body, draftBody)) ctx.logger.info(line);
            ctx.logger.info('');

            let approved: boolean;
            try {
                approved = unwrap(await prompts.confirm({ message: `Write this as a new version of ${cardId}?` }));
            } catch (err) {
                if (!(err instanceof PromptCancelledError)) throw err;
                approved = false;
            }

            if (!approved) {
                ctx.logger.info('declined. Nothing written.');
                return 0;
            }

            await board.write(cardId, `Plan ${cardId}: ${card.frontmatter.title}`, current => ({ ...current, body: draftBody }));
            ctx.logger.info(`${cardId} planned — new version written.`);
            return 0;
        } finally {
            // Both the worktree and its throwaway branch removed on every exit, pass or fail — never
            // the card's real worktree or branch, since `planId` and `planBranch` were never the
            // card's own.
            await worktrees.abandon(planId, planBranch);
        }
    }),
};

/** The same six headings `card create` seeds, built from the shared constant so the two cannot drift. */
const SKELETON = PLAN_SECTIONS.map(section => `## ${section}\n`).join('\n');

/**
 * A minimal line-level diff, LCS-based, with no context lines — just what was added and removed.
 * Good enough for "show the operator what changed" without pulling in a diff dependency this package
 * does not have.
 */
const diffLines = (before: string, after: string): string[] => {
    const a = before.split('\n');
    const b = after.split('\n');
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
        }
    }

    const lines: string[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i += 1;
            j += 1;
        } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
            lines.push(`- ${a[i]}`);
            i += 1;
        } else {
            lines.push(`+ ${b[j]}`);
            j += 1;
        }
    }
    while (i < a.length) {
        lines.push(`- ${a[i]}`);
        i += 1;
    }
    while (j < b.length) {
        lines.push(`+ ${b[j]}`);
        j += 1;
    }
    return lines;
};

export default command;
