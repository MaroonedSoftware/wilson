import type { CommandModule } from '@maroonedsoftware/johnny5';
import { requireContainer } from '@maroonedsoftware/johnny5/serverkit';
import { BoardRepository } from '@wilson/api/cli-bootstrap';
import { editBody, nextCardId } from './editor.js';

interface CreateOpts {
    stage?: string;
}

/**
 * Create a card.
 *
 * The board has no files to write by hand any more, so this is how a card comes into existence
 * outside the web app. It opens `$EDITOR` on a plan skeleton for the same reason `git commit` does:
 * the body is prose, and prose does not belong on a command line.
 *
 * New cards land in `parking-lot` unless told otherwise — a stub with a title and a note, promoted
 * into planning by a human (PROJECT.md, Parking lot).
 */
const command: CommandModule<CreateOpts> = {
    description: 'Create a card, opening $EDITOR for its body',
    args: [{ name: 'title', description: 'The card title', required: true }],
    options: [{ flags: '--stage <stage>', description: 'Stage to create it in (default: parking-lot)', type: 'string' }],
    run: requireContainer<CreateOpts>(async (opts, ctx, args) => {
        const title = String(args[0]);
        const board = ctx.container.get(BoardRepository);
        const stage = opts.stage ?? 'parking-lot';

        const id = nextCardId(await board.list());
        const body = await editBody(SKELETON, `wilson-card-${id}`);
        if (body === undefined) {
            ctx.logger.info('empty body — card not created');
            return 1;
        }

        await board.create({ frontmatter: { id, title, stage, dependsOn: [], retries: {} }, sections: {}, body }, `Create ${id}: ${title}`);

        ctx.logger.info(`${id} created in ${stage}`);
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
