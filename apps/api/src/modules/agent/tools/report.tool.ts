import { tool } from 'ai';
import type { z } from 'zod';

export const REPORT_TOOL = 'report_result';

/**
 * How a stage returns its result.
 *
 * Structured output as the loop's terminator did not survive contact with a tool loop: across five
 * runs of card 0002 the model produced "placeholder", "nope", "s :=" and finally nothing at all,
 * each time ending the loop without doing the work. Making the report an explicit tool call fixes
 * the ordering — the loop ends because the agent said it was finished, not because a schema happened
 * to be satisfiable.
 *
 * It also matches what the design already asked for: a stage writes a machine-readable result, and
 * prose is not a stage result.
 */
export const reportTool = (schema: z.ZodTypeAny) =>
    tool({
        description:
            'Report the work you have completed and end the stage. Call this exactly once, only after you have made every change the plan asks for and the build passes. Calling it early ends the stage with the work unfinished.',
        inputSchema: schema,
        // No execute: the value is the call itself, which the dispatcher reads back off the step.
        execute: async (input: unknown) => {
            void input;
            return 'reported';
        },
    });
