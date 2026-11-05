import { z } from 'zod';
import { AppGrant } from '#src/generated/apps.js';

/**
 * The operation name a proposed operator app is stored under. It is not in the catalog (`apps.ck` is
 * `mcp: exclude`), so `propose_change` can never reach it and no other agent can see it. Only
 * `ChatService.decide` runs it, with the checks an install over HTTP has.
 */
export const PROPOSED_APP_OPERATION = 'install_proposed_app';

/**
 * What a proposed app's action stores. `requestedGrants` is what the agent says the app needs, for the
 * review to show. It is never what the app is installed with: that comes from the person's confirm.
 */
export const ProposedAppArguments = z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    html: z.string(),
    requestedGrants: z.array(AppGrant),
});
export type ProposedAppArguments = z.infer<typeof ProposedAppArguments>;
