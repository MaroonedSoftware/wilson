import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandModule } from '@maroonedsoftware/johnny5';
import { PromptCancelledError, prompts, unwrap } from '@maroonedsoftware/johnny5';
import { describeApiError, withApi } from '../../api-client.js';
import { subscriptionEnv } from '../../board-view.js';
import { runInteractive } from './editor.js';

/**
 * Plan a card: an interactive conversation with an agent that can read the repo, ending in a plan a
 * person approved.
 *
 * This command stays local for the one part that must be: the interactive `claude` conversation
 * itself, hosted in this process's own terminal (`stdio: 'inherit'`), the same way `editor.ts` spawns
 * `$EDITOR`. Everything around it is now the API's: `POST /api/cards/:id/plan/open`
 * (`PlanService.open`, card 0077) runs the same two guards this command used to make itself — refuse
 * a card outside `planning`, refuse one whose real branch already has work — cuts the throwaway
 * worktree, and seeds the draft file this command reads back afterward; `plan/save` validates the
 * six headings and a non-empty "Files in scope" server-side, so this command no longer has its own
 * copy of that check; `plan/close` reclaims the worktree and deletes its branch. `close` runs in a
 * `finally` so it fires on every exit path including a thrown error — the one thing that must not
 * leak a worktree.
 *
 * The plan comes back through the scratch file at `draftPath`, not an MCP tool: `createSdkMcpServer`
 * is in-process to `query()` and unreachable from a spawned binary, and standing up a second `wilson`
 * subcommand behind `--mcp-config` is a lot of new surface for what a file already does. Writing
 * through that file also puts the board write behind an explicit human confirmation here, which is
 * what "approval is explicit and versioned" asks for.
 */
const command: CommandModule = {
    description: 'Plan a card in an interactive session with an agent that can read the repo, ending in a written plan',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const before = await api.board.getCard(cardId);
        const session = await api.board.openAPlanningSession(cardId);

        try {
            const initialPrompt = [
                `Card ${cardId}: ${before.title}`,
                '',
                `You are in a fresh worktree of the code repo at ${session.worktreePath}, cut from HEAD for this`,
                `planning session only — it is not the card's real branch, and nothing written here survives`,
                `past this session. Read whatever you need here to write an informed plan.`,
            ].join('\n');

            // A settings deny list in a spawned process, not `ScopeGuard` — weaker, and dependent on
            // the installed `claude` version's settings schema. It does not make the worktree
            // read-only; it denies Edit there and allows it on the one file outside the worktree that
            // matters, and the worktree is discarded either way once `plan/close` reclaims it.
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

            if (draftBody === before.body) {
                ctx.logger.info('draft is unchanged. Nothing written.');
                return 0;
            }

            ctx.logger.info(`\n${cardId}: ${before.title}\n`);
            for (const line of diffLines(before.body, draftBody)) ctx.logger.info(line);
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

            // Refuses, naming what is missing, for an incomplete draft — the same refusal this
            // command used to make itself before writing (see the module doc).
            await api.board.saveAPlanDraft(cardId, { body: draftBody });
            ctx.logger.info(`${cardId} planned — new version written.`);
            return 0;
        } finally {
            // Idempotent and safe even if nothing above ran to completion — closing must never
            // itself be the operation that fails, or leaks the worktree it exists to reclaim.
            await api.board.closeAPlanningSession(cardId).catch(err => {
                ctx.logger.warn(`could not close planning session for ${cardId}: ${describeApiError(err, ctx)}`);
            });
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
