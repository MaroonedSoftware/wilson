import { bashTool } from './bash.tool.js';
import { fileTools } from './file.tools.js';
import { scopeTool } from './scope.tool.js';
import { searchTools } from './search.tools.js';
import type { ToolContext } from './tool.context.js';

/** The whole tool set an agent stage gets. Stage config narrows it via `activeTools`. */
export const buildTools = (ctx: ToolContext) => ({
    ...fileTools(ctx),
    ...searchTools(ctx),
    bash: bashTool(ctx),
    request_scope: scopeTool(ctx),
});

export type AgentTools = ReturnType<typeof buildTools>;
export * from './tool.context.js';
