import { tool } from 'ai';
import { BlockedReportSchema } from '../blocked.report.js';

export const BLOCKED_TOOL = 'report_blocked';

export const BLOCKED_TOOL_DESCRIPTION =
    'Stop this stage and ask a person one question. Only for what the repo, the plan and the commands you can run cannot tell you. Calling it ends the stage at once, whatever else you were doing.';

/**
 * How a stage asks a person something instead of failing. A tool of its own rather than a union in
 * the result schema, so `report_result` keeps meaning the work is finished. No `execute` work to do:
 * the value is the call, which the adapter reads back off the step, as with the report tool.
 */
export const blockedTool = () =>
    tool({
        description: BLOCKED_TOOL_DESCRIPTION,
        inputSchema: BlockedReportSchema,
        execute: async (input: unknown) => {
            void input;
            return 'asked';
        },
    });

/**
 * What every adapter's prompt says about asking, given what it calls the tool. Only for a stage that
 * has the tool, which a step does not: an answer resumes the lane's own run, so the step would be lost.
 */
export const blockedGuidance = (toolName: string): string[] => [
    `If you cannot go on without a person's decision, call ${toolName} with one question. Ask only what`,
    'the repo, the plan and the commands you can run cannot tell you. Where you can make a reasonable',
    'choice yourself, make it and say so in your result. That call ends the stage at once: anything you',
    'have not committed is kept as a patch, and a fresh session gets the answer in the plan, under',
    '"## Operator answer".',
];
