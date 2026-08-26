import type { CommandModule } from '@maroonedsoftware/johnny5';
import { PromptCancelledError, prompts, unwrap } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Turn a refused card's recorded scope-check division into cards, on confirmation.
 *
 * `scope-check` proposes the division and this command only acts on it (card 0105's constraint):
 * `GET .../division` (`BoardWriteService.division`, card 0113) reads the most recent refusal on
 * record for `cardId` — never a fresh `scope-check` run, which could return a different split for
 * the cost of a whole pass — and this command renders it, lets an operator add to each piece's
 * reported `dependsOn` (never trusted blindly: an empty array means "the model did not say" as often
 * as it means "independent"), and only then calls `POST .../split` to create anything.
 *
 * A card with no scope-check refusal on record, or one whose refusal carried no division, is a
 * `division` request that throws — `withApi` turns that into the operator-facing reason and a
 * non-zero exit, the same as every other refusal on this surface.
 */
const command: CommandModule = {
    description: "Turn a card's recorded scope-check refusal into cards, on confirmation",
    args: [{ name: 'cardId', description: 'The refused card id, e.g. 0111', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);

        const division = await api.board.getCardDivision(cardId);
        const titles = division.pieces.map(piece => piece.title);

        ctx.logger.info(`\n${cardId} refused: ${division.reason}\n`);

        // Surface each piece's tasks and delivers before asking anything, and let the operator add
        // to `dependsOn` right there — never inferred from `delivers` prose, and never limited to
        // what the division itself reported.
        const finalDependsOn = new Map<string, string[]>();
        for (const piece of division.pieces) {
            ctx.logger.info(`${piece.title}`);
            for (const task of piece.tasks) ctx.logger.info(`  - ${task}`);
            ctx.logger.info(`  delivers: ${piece.delivers}`);
            ctx.logger.info(`  reported dependsOn: ${piece.dependsOn.length > 0 ? piece.dependsOn.join(', ') : '(none)'}`);

            const others = titles.filter(title => title !== piece.title);
            if (others.length === 0) {
                finalDependsOn.set(piece.title, []);
                continue;
            }

            let chosen: string[];
            try {
                chosen = unwrap(
                    await prompts.multiselect<string>({
                        message: `${piece.title}: which other pieces does it actually depend on?`,
                        options: others.map(title => ({ value: title, label: title })),
                        initialValues: piece.dependsOn.filter(dep => others.includes(dep)),
                        required: false,
                    }),
                );
            } catch (err) {
                if (!(err instanceof PromptCancelledError)) throw err;
                ctx.logger.info('declined. Nothing written.');
                return 0;
            }
            finalDependsOn.set(piece.title, chosen);
        }

        // One confirmation, showing everything — titles, tasks, what each delivers (already printed
        // above), and now the dependencies as they will actually be recorded — before anything is
        // written.
        ctx.logger.info(`\n${cardId} would be split into ${division.pieces.length} cards in planning:\n`);
        for (const piece of division.pieces) {
            const deps = finalDependsOn.get(piece.title) ?? [];
            ctx.logger.info(`  ${piece.title} — depends on: ${deps.length > 0 ? deps.join(', ') : 'none recorded'}`);
        }
        ctx.logger.info(`\n${cardId} itself stays where it is — this only annotates it with the ids it was split into.`);
        ctx.logger.info('The new cards land with no plans of their own; `wilson card plan` each before it can run.\n');

        let approved: boolean;
        try {
            approved = unwrap(await prompts.confirm({ message: `Create ${division.pieces.length} cards in planning from this division?` }));
        } catch (err) {
            if (!(err instanceof PromptCancelledError)) throw err;
            approved = false;
        }

        if (!approved) {
            ctx.logger.info('declined. Nothing written.');
            return 0;
        }

        const result = await api.board.splitCard(cardId, {
            pieces: division.pieces.map(piece => ({
                title: piece.title,
                tasks: piece.tasks,
                delivers: piece.delivers,
                dependsOn: finalDependsOn.get(piece.title) ?? [],
            })),
        });

        for (const card of result.pieces) {
            ctx.logger.info(`${card.id} created in ${card.stage}: ${card.title}`);
        }
        ctx.logger.info(`\n${cardId} was not moved or dropped; it now lists the ids above. Plan each before starting it.`);
        return 0;
    }),
};

export default command;
