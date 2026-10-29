import type { CommandModule } from '@maroonedsoftware/johnny5';
import { DateTime } from 'luxon';
import type { CardEvent, CardUsage } from '@wilson/sdk';
import { withApi } from '../../api-client.js';
import { deadDependencies, describeDependency, filesInScope, timeInCurrentStage, unsatisfiedDependencies } from '../../board-view.js';

interface ShowOpts {
    json?: boolean;
}

/**
 * Card 0100: every other event type reads fine as bare `type (stage)` — a reader already knows what
 * `transition.written` or `stage.passed` means. `daemon.stale` does not: the entire point of
 * recording it was "how far behind, and which two commits", and printing only the type name would
 * make it indistinguishable from a passing check that never ran — exactly the "a log line nobody
 * reads" failure the card exists to fix. So this one type gets its payload rendered; nothing else
 * does, on purpose.
 */
const describeEvent = (event: CardEvent): string => {
    const base = `${event.createdAt.toUTC().toISO()}  ${event.type}${event.stage ? ` (${event.stage})` : ''}`;
    if (event.type !== 'daemon.stale') return base;

    const payload = event.payload as unknown as { daemonCommit?: string; baseCommit?: string; behindBy?: number } | null;
    if (!payload || typeof payload.behindBy !== 'number') return base;

    return `${base}  — daemon ${payload.behindBy} commit(s) behind (running ${payload.daemonCommit}, base ${payload.baseCommit})`;
};

/**
 * Card 0263: what the card has cost, one line per stage plus a total — tokens read from the event
 * log's `stage.passed`/`stage.failed` rows, never a dollar figure (`GET .../usage`'s own doc comment
 * on why: every stage here runs through the subscription-billed `cli` adapter). Prints nothing for
 * a card with no usage recorded yet, the same "nothing to show" the events section above it follows.
 */
const printUsage = (logger: { info: (message: string) => void }, usage: CardUsage): void => {
    if (usage.stages.length === 0) return;

    logger.info('\nusage:');
    for (const stage of usage.stages) {
        logger.info(`  ${stage.stage}: ${stage.attempts} attempt(s), ${stage.inputTokens} in / ${stage.outputTokens} out`);
    }
    logger.info(`  total: ${usage.total.attempts} attempt(s), ${usage.total.inputTokens} in / ${usage.total.outputTokens} out`);
};

/**
 * `retries` and `planVersionId` are frontmatter fields the board API's wire contract does not
 * expose (`CardSummary`/`CardDetail` in `@wilson/sdk` — card 0080's contract). They dropped out of
 * this view along with the container it used to read them from; restoring them is a contract change
 * for a card of its own, not something a client can add back.
 */
const command: CommandModule<ShowOpts> = {
    description: 'Show a card: its state, its files in scope, and the tail of its event log',
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    options: [{ flags: '--json', description: 'Print the card state as a single JSON object', type: 'boolean' }],
    run: withApi<ShowOpts>(async (opts, ctx, args, api) => {
        const cardId = String(args[0]);
        const card = await api.board.getCard(cardId);

        const events = await api.board.listCardEvents(cardId, { limit: 20 });
        const timeInStage = timeInCurrentStage(events, DateTime.utc());
        const usage = await api.board.getCardUsage(cardId);

        // Satisfaction can't be judged from this one card, so the board's other cards are needed to
        // say what's really blocking — but only when there is a dependency to check at all, so a card
        // naming none stays a single request (`wilson card next` always fetches the board, but it has
        // to look at every card anyway; `show` doesn't).
        let blockedOn: string[] = [];
        if (card.dependsOn.length > 0) {
            const [cards, columns] = await Promise.all([api.board.listCards(), api.board.listBoardColumns()]);
            const outstanding = unsatisfiedDependencies(card, cards);
            const dead = deadDependencies(card, cards, columns.nonStages);
            blockedOn = outstanding.map(id => describeDependency(id, cards, dead));
        }

        if (opts.json) {
            const scope = filesInScope(card.sections);
            ctx.logger.info(
                JSON.stringify(
                    {
                        id: card.id,
                        title: card.title,
                        stage: card.stage,
                        branch: card.branch ?? null,
                        dependsOn: card.dependsOn,
                        filesInScope: scope,
                        secondsInStage: timeInStage ? timeInStage.as('seconds') : null,
                        needsHuman: card.needsHuman,
                        needsHumanReason: card.needsHumanReason ?? null,
                    },
                    null,
                    2,
                ),
            );
            return 0;
        }

        ctx.logger.info(`${card.id}  ${card.title}`);
        ctx.logger.info(`stage:    ${card.stage}`);
        if (timeInStage) ctx.logger.info(`for:      ${timeInStage.shiftTo('days', 'hours', 'minutes').toHuman()}`);
        ctx.logger.info(`branch:   ${card.branch ?? '—'}`);
        if (blockedOn.length > 0) ctx.logger.info(`blocked:  ${blockedOn.join(', ')}`);
        if (card.needsHuman) ctx.logger.info(`needs human: ${card.needsHumanReason ?? '(no reason given)'}`);

        const scope = filesInScope(card.sections);
        ctx.logger.info(`\nfiles in scope (${scope.length}):`);
        for (const glob of scope) ctx.logger.info(`  ${glob}`);

        if (events.length > 0) {
            ctx.logger.info('\nrecent events:');
            for (const event of events) {
                ctx.logger.info(`  ${describeEvent(event)}`);
            }
        }

        printUsage(ctx.logger, usage);
        return 0;
    }),
};

export default command;
