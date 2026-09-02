import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

/**
 * Card 0195. `wilson card lint <id>` — the operator's way to run [[0193]]'s `PlanLintService`
 * without writing a request by hand. Every judgement lives in that service, reached here through
 * the generated SDK's `lintACardPlan`: this command calls it and prints whatever comes back, so it
 * can never drift from what the runner itself will enforce.
 *
 * A `LintFinding` is an observation, not a defect — see `LintFinding`'s own doc comment
 * (`packages/sdk/src/types/board.ts`). A plan can be correct and still report: quoting a shell
 * command as prose the runner will scan for, or a `Files in scope` line an `alwaysAllowed` entry
 * already covers. The wording below stays neutral on purpose — "here is what the runner will make
 * of this plan", never "errors" or "must fix" — so it doesn't teach an operator to churn a good
 * plan or to ignore the command outright.
 *
 * Exit code follows `wilson doctor`'s precedent: 1 when there is something to look at, 0 when
 * there is nothing, so this can sit in a shell loop or a pre-approve habit without parsing text.
 */
const command: CommandModule = {
    description: "Check a card's plan against the config the runner will enforce, and report what it finds",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);
        const findings = await api.board.lintACardPlan(cardId);

        if (findings.length === 0) {
            ctx.logger.info(`${cardId}: no findings`);
            return 0;
        }

        ctx.logger.info(`${cardId}: ${findings.length} finding(s) — what the runner will make of this plan, not a list of errors to fix`);
        for (const finding of findings) {
            ctx.logger.info(`  [${finding.kind}] ${finding.message}`);
        }
        return 1;
    }),
};

export default command;
