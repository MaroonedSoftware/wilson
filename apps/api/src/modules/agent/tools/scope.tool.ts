import { tool } from 'ai';
import { z } from 'zod';
import { ScopeKickbackError, type ToolContext } from './tool.context.js';

/**
 * Ask for a path outside the plan's files in scope.
 *
 * Not an exception path — an auditable one. The request and its reason are recorded whichever way
 * the policy falls, so a widening is a fact about the run that the review stage can see, rather than
 * a silent bypass (PROJECT.md, Scope enforcement).
 *
 * Shared by both adapters' `request_scope` tools — the `api` adapter's via {@link scopeTool} below,
 * and the `cli` adapter's in-process MCP tool — so the two cannot drift in what a grant means.
 */
export const requestScope = async (ctx: ToolContext, path: string, reason: string): Promise<string> => {
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

    const granted = await ctx.scope.grant(path);
    if (!granted.allowed) {
        // Refused rather than recorded: a grant that containment would still refuse is a
        // widening the operator would see in the log but that never actually happened.
        await ctx.events.append({
            project: ctx.project,
            cardId: ctx.cardId,
            stage: ctx.stage,
            type: 'scope.refused',
            payload: { path, reason, refusal: granted.reason },
        });
        return `error: ${granted.reason} (${path}). This path can never be written from this stage.`;
    }

    await ctx.events.append({
        project: ctx.project,
        cardId: ctx.cardId,
        stage: ctx.stage,
        type: 'scope.granted',
        payload: { path, reason },
    });
    return `granted: ${granted.path} is writable for this run, and the widening is recorded on the card.`;
};

export const scopeTool = (ctx: ToolContext) =>
    tool({
        description:
            'Request permission to write a file outside the plan’s files in scope. Explain why the plan did not anticipate it. Use sparingly.',
        inputSchema: z.object({
            path: z.string().describe('Path relative to the worktree root.'),
            reason: z.string().describe('Why this file is genuinely part of this card.'),
        }),
        execute: async ({ path, reason }) => requestScope(ctx, path, reason),
    });
