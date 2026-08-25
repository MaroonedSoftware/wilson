import type { z } from 'zod';
import { bashTool } from './bash.tool.js';
import { deleteTool } from './delete.tool.js';
import { fileTools } from './file.tools.js';
import { REPORT_TOOL, reportTool } from './report.tool.js';
import { scopeTool } from './scope.tool.js';
import { searchTools } from './search.tools.js';
import type { ToolContext } from './tool.context.js';

/**
 * The full read-write tool set. `write`, `edit`, `delete` and `request_scope` are typed as always
 * present — a `readonly`/`none` worktree mode still physically deletes them from the object
 * `buildTools` returns, but declaring them optional here would make `ToolLoopAgent`'s tool generic
 * carry an optional modifier, and its `TypedToolCall` mapped type is homomorphic: an optional key
 * there comes back out with `| undefined` on the whole tool-call union, breaking every step's
 * `toolCalls` typing downstream in the dispatcher. Keeping the keys required avoids that; the
 * stage config's `activeTools` (and `worktreeMode` below) is what actually keeps a reviewer from
 * calling them.
 */
type StageTools = ReturnType<typeof fileTools> &
    ReturnType<typeof searchTools> & {
        bash: ReturnType<typeof bashTool>;
        delete: ReturnType<typeof deleteTool>;
        request_scope: ReturnType<typeof scopeTool>;
        [REPORT_TOOL]: ReturnType<typeof reportTool>;
    };

/**
 * The whole tool set an agent stage gets. Stage config narrows it via `activeTools`.
 *
 * A `readonly` or `none` worktree mode drops `write`, `edit`, `delete` and `request_scope` from the
 * set entirely rather than leaving them for the ScopeGuard to deny — a reviewer should not have the
 * tool to edit the code it is reviewing in the first place.
 */
export const buildTools = (ctx: ToolContext, resultSchema: z.ZodTypeAny, worktreeMode: 'none' | 'readonly' | 'rw' = 'rw'): StageTools => {
    const { write, edit, ...readOnlyFileTools } = fileTools(ctx);
    const canWrite = worktreeMode === 'rw';

    // The object below only has `write`/`edit`/`delete`/`request_scope` when `canWrite` is true —
    // StageTools declares them required so ToolLoopAgent's TypedToolCall stays sound (see the
    // comment above). The cast is the deliberate seam: the ScopeGuard/dispatcher never call these
    // tools directly, so the mismatch cannot surface as a runtime error, only as a declaration the
    // model never sees the tool advertised for when it is genuinely absent.
    return {
        ...readOnlyFileTools,
        ...(canWrite ? { write, edit } : {}),
        ...searchTools(ctx),
        bash: bashTool(ctx),
        ...(canWrite ? { delete: deleteTool(ctx), request_scope: scopeTool(ctx) } : {}),
        [REPORT_TOOL]: reportTool(resultSchema),
    } as StageTools;
};

export type AgentTools = StageTools;
export * from './tool.context.js';
export { REPORT_TOOL } from './report.tool.js';
