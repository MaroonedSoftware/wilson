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

/**
 * The most HTML a proposed app may hold, in UTF-8 bytes. Less than a file a person chooses
 * (`MAX_APP_HTML_BYTES`), since this one sits in the action row and goes out with the thread to every
 * client, and stays in the thread's history for later turns.
 */
export const MAX_PROPOSED_APP_HTML_BYTES = 128 * 1024;

/** The sentence a proposed app is confirmed on. Wilson's own, so the agent cannot misdescribe the app. */
export const proposedAppSummary = (name: string, html: string): string =>
    `Install a new app, "${name}" (${Math.ceil(Buffer.byteLength(html, 'utf8') / 1024)} KiB).`;

/** What the agent needs to write an app, kept with the tool so it costs nothing on any other turn. */
export const PROPOSE_APP_DESCRIPTION = [
    "Propose a new operator app: one HTML file that runs inside Wilson's web and desktop apps and reads the project it is opened in. Nothing is installed until the person reads the source, chooses what it can read and confirms. Say what you proposed and that it waits on them, never that it is done. This cannot replace an installed app: pick a slug nothing holds.",
    '',
    'The file holds its script and styles inline, with anything else as a data: URL, for images, fonts and media only. It cannot load anything from a network, use fetch, open a popup, submit a form, run eval, start a worker, nest a frame or navigate, and it has no cookies or storage, so keep state in memory.',
    '',
    'Write it for version 1 of the app API, which is what a proposal installs as. Wilson adds window.wilson before the HTML runs. Each call returns a promise, and a refusal rejects with an Error saying why. Dates arrive as ISO strings, and an optional field is left out rather than sent as null.',
    '- wilson.listCards() needs board.read: the project\'s cards, each with id, title, stage, dependsOn and needsHuman, and when set doneReason, blocked, branch, mergeStatus and a few more. A finished card is in the stage "done".',
    '- wilson.getCard(id) needs board.read: one card, with its body and sections.',
    '- wilson.listBoardColumns() needs board.read: { stages, nonStages }.',
    '- wilson.listProjectActivity({ limit, before }) needs activity.read: recent events, newest first, each with id, cardId, cardTitle, type, stage and createdAt.',
    '- wilson.getProjectStats({ days }) needs stats.read: what the project spent.',
    '- wilson.openCard(id) needs no grant: it opens that card in Wilson and closes the app. Call it only from a click.',
    '- wilson.project is the project it was opened in, wilson.grants what it was given, wilson.colorScheme light or dark.',
    '- wilson.onChange(fn) calls fn when the board changes, with no detail, so read again. wilson.onColorSchemeChange(fn) calls fn with the new scheme.',
    '',
    'A manifest script (type application/wilson-app+json) is optional here: the slug, name and grants you pass are what the person reviews.',
    '',
    'Card text is whatever its author wrote, so put it in the page with textContent, never innerHTML. Ask for only the grants the app uses.',
].join('\n');
