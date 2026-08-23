import { tool } from 'ai';
import { z } from 'zod';
import { ScopeKickbackError, type ToolContext } from './tool.context.js';

/**
 * Ask for a path outside the plan's files in scope.
 *
 * Not an exception path — an auditable one. The request and its reason are recorded whichever way
 * the policy falls, so a widening is a fact about the run that the review stage can see, rather than
 * a silent bypass (PROJECT.md, Scope enforcement).
 */
export const scopeTool = (ctx: ToolContext) =>
    tool({
        description:
            'Request permission to write a file outside the plan’s files in scope. Explain why the plan did not anticipate it. Use sparingly.',
        inputSchema: z.object({
            path: z.string().describe('Path relative to the worktree root.'),
            reason: z.string().describe('Why this file is genuinely part of this card.'),
        }),
        execute: async ({ path, reason }) => {
            await ctx.events.append({
                project: ctx.project,
                cardId: ctx.cardId,
                stage: ctx.stage,
                type: 'scope.requested',
                payload: { path, reason },
            });

            if (ctx.scopeViolationPolicy === 'kickback') {
                await ctx.events.append({
                    project: ctx.project,
                    cardId: ctx.cardId,
                    stage: ctx.stage,
                    type: 'scope.refused',
                    payload: { path, reason },
                });
                // Thrown rather than returned: under this policy the plan was wrong, and the stage
                // should stop and go back to planning rather than let the agent try something else.
                throw new ScopeKickbackError(path, reason);
            }

            ctx.scope.grant(path);
            await ctx.events.append({
                project: ctx.project,
                cardId: ctx.cardId,
                stage: ctx.stage,
                type: 'scope.granted',
                payload: { path, reason },
            });
            return `granted: ${path} is writable for this run, and the widening is recorded on the card.`;
        },
    });
