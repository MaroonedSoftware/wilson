import { z } from 'zod';

/**
 * What a stage says when it stops to ask a person one question (`report_blocked`). Flat on purpose:
 * this crosses the engines' tool transports as tool arguments, which is where nested schemas have
 * gone missing before (`cli.stage.agent.ts`, on `report_result`).
 */
export const BlockedReportSchema = z.object({
    category: z
        .enum(['decision', 'access', 'requirements', 'environment', 'other'])
        .describe(
            'decision: a choice only a person can make. access: a credential or permission you lack. requirements: the plan contradicts itself or the repo. environment: the machine or a service, not the code. other: none of these.',
        ),
    tried: z.string().min(1).describe('What you already tried or checked, so nobody suggests it back to you.'),
    question: z.string().min(1).describe('The one question to answer. A person reads it with no other context, so make it stand alone.'),
    options: z.array(z.string().min(1)).optional().describe('Likely answers, when you can name them.'),
    recommended: z
        .string()
        .min(1)
        .optional()
        .describe(
            'The answer you would pick if it were up to you, with the reason in a few words. A person sees it first and can accept it in one click, so give one whenever you have a view.',
        ),
});

export type BlockedReport = z.infer<typeof BlockedReportSchema>;
