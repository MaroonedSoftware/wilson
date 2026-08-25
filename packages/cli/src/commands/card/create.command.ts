import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';
import { editBody } from './editor.js';

interface CreateOpts {
    stage?: string;
}

/**
 * Create a card.
 *
 * The board has no files to write by hand any more, so this is how a card comes into existence
 * outside the web app. It opens `$EDITOR` on a plan skeleton for the same reason `git commit` does:
 * the body is prose, and prose does not belong on a command line. `$EDITOR` handling is the one part
 * of this command that stays local — the editor is a terminal concern, and only the finished text
 * crosses the wire; the id itself is assigned by the API (the next sequential one over the current
 * board), not computed here.
 *
 * New cards land in `parking-lot` unless told otherwise — a stub with a title and a note, promoted
 * into planning by a human (PROJECT.md, Parking lot).
 */
const command: CommandModule<CreateOpts> = {
    description: 'Create a card, opening $EDITOR for its body',
    args: [{ name: 'title', description: 'The card title', required: true }],
    options: [{ flags: '--stage <stage>', description: 'Stage to create it in (default: parking-lot)', type: 'string' }],
    run: withApi<CreateOpts>(async (opts, ctx, args, api) => {
        const title = String(args[0]);
        const stage = opts.stage ?? 'parking-lot';

        const body = await editBody(SKELETON, 'wilson-card-new');
        if (body === undefined) {
            ctx.logger.info('empty body — card not created');
            return 1;
        }

        const card = await api.board.createCard({ title, stage, body });

        ctx.logger.info(`${card.id} created in ${stage}`);
        return 0;
    }),
};

const SKELETON = `
## Goal

## Constraints

## Files in scope

## Tasks

## Acceptance criteria

## Out of scope
`;

export default command;
