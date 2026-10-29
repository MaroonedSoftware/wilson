import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { PromptCancelledError, prompts, unwrap } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { runInteractive } from './editor.js';

/**
 * The environment the spawned `claude` runs with, minus any provider API key.
 *
 * `apps/api/.env` (or the operator's own shell) may set `ANTHROPIC_API_KEY`, and a spawned `claude`
 * prefers a key over the operator's own subscription credentials when it sees one — silently
 * rerouting to per-token billing, which is the exact thing this exists to avoid.
 *
 * Copied, not moved, from `subscriptionEnv` in `apps/api/src/modules/agent/cli.stage.agent.ts`: that
 * copy still serves `CliStageAgent`, which this package cannot import any more (card 0085 drops
 * `@wilson/api` from `packages/cli` entirely), and duplicating four lines is cheaper and safer than
 * inventing a shared package for them.
 */
const subscriptionEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
};

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
 *
 * This command used to build its own container (`@wilson/api/cli-bootstrap`) rather than calling the
 * API like every other command in this package — it was the one command that could not simply call
 * an endpoint, because it hands the operator's terminal to an interactive process. Card 0077 split
 * `PlanService` out of the old container-only logic so the server could own the half that does not
 * need a terminal (cutting the throwaway worktree, validating and saving the finished draft, tearing
 * the worktree down); card 0085 is what points this command at it, dropping `@wilson/api` from this
 * package entirely. What is left here is exactly the half that must run locally: spawning `claude`
 * with the operator's own stdio, and the confirmation prompt.
 */
const command: CommandModule = {
    description: 'Plan a card in an interactive session with an agent that can read the repo, ending in a written plan',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        // The card's current title and body, for the initial prompt and the diff below. `open` below
        // re-runs card 0058's guards server-side (`PlanService.open`) and is what actually refuses a
        // card that is not in `planning` or already has work on its branch — this call exists only to
        // read what `open`'s response does not carry.
        const card = await api.board.getCard(cardId);

        const session = await api.board.openAPlanningSession(cardId);
        try {
            const initialPrompt = [
                `Card ${cardId}: ${card.title}`,
                '',
                `You are in a fresh worktree of the code repo at ${session.worktreePath}, cut from HEAD for this`,
                `planning session only — it is not the card's real branch, and nothing written here survives`,
                `past this session. Read whatever you need here to write an informed plan.`,
            ].join('\n');

            // A settings deny list in a spawned process, not `ScopeGuard` — weaker, and dependent on
            // the installed `claude` version's settings schema. It does not make the worktree
            // read-only; it denies Edit there and allows it on the one file outside the worktree that
            // matters, and the worktree is discarded either way.
            const settings = {
                permissions: {
                    deny: [`Edit(${session.worktreePath}/**)`],
                    allow: [`Edit(${session.draftPath})`],
                },
            };

            await runInteractive(
                'claude',
                [
                    initialPrompt,
                    '--model',
                    session.model,
                    // The stage's own instructions plus where the draft lives, already combined by
                    // `PlanService.open` — appended as the system prompt so the model sees it with the
                    // same weight as its base instructions, not as a user turn it might treat as
                    // negotiable.
                    '--append-system-prompt',
                    session.instructions,
                    '--add-dir',
                    dirname(session.draftPath),
                    '--settings',
                    JSON.stringify(settings),
                    // Never 'plan': plan mode blocks the very write this command depends on, and its
                    // exit path hands the agent permission to start implementing — the one thing a
                    // planning session must not do.
                    '--permission-mode',
                    'default',
                ],
                { cwd: session.worktreePath, env: subscriptionEnv() },
            );

            const draftBody = await readFile(session.draftPath, 'utf8');

            // Checked here, before showing a diff or asking to confirm, rather than left to `save`:
            // an unchanged draft has nothing to show or confirm, and `save` (`PlanService.save`) makes
            // this same comparison itself — checking it early just skips the empty prompt. Section
            // completeness and a non-empty "Files in scope" are deliberately *not* re-checked here:
            // `save` validates both server-side and refuses naming what is missing, so a confirmed
            // draft that turns out incomplete fails there, as a normal API refusal, rather than behind
            // a second copy of the same validation.
            if (draftBody === card.body) {
                ctx.logger.info('draft is unchanged. Nothing written.');
                return 0;
            }

            ctx.logger.info(`\n${cardId}: ${card.title}\n`);
            for (const line of diffLines(card.body, draftBody)) ctx.logger.info(line);
            ctx.logger.info('');

            let approved: boolean;
            try {
                approved = unwrap<boolean>(await prompts.confirm({ message: `Write this as a new version of ${cardId}?` }));
            } catch (err) {
                if (!(err instanceof PromptCancelledError)) throw err;
                approved = false;
            }

            if (!approved) {
                ctx.logger.info('declined. Nothing written.');
                return 0;
            }

            await api.board.saveAPlanDraft(cardId, { body: draftBody });
            ctx.logger.info(`${cardId} planned — new version written.`);
            return 0;
        } finally {
            // Closed on every exit path, pass or fail — an unclosed session leaks the throwaway
            // worktree `open` cut, the leak card 0064 stopped and card 0077 made recoverable by
            // reopening. `close` (`PlanService.close`) is idempotent, so calling it after a declined
            // confirmation or a `save` refusal is exactly as safe as calling it after a real write.
            await api.board.closeAPlanningSession(cardId);
        }
    }),
};

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
