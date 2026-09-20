import type { SettingDefinition } from './setting.definition.js';

/**
 * How many output tokens a project may spend on `card.stage` attempts in one day before `Poller`
 * stops enqueueing it and `BoardWriteService.start` (`wilson card start`) refuses — card 0264, off
 * card 0263's finding that a poller left ticking against a card that fails the same way every time
 * spends that card's whole budget one stage attempt at a time: card 0249 alone cost 10 attempts and
 * 218,009 output tokens before anything stopped it.
 *
 * **Output, not input.** Every stage on this board runs through the subscription-billed `cli`
 * adapter (card 0263's Constraints), which reports real output-token counts but an input count too
 * small to mean anything — 12 to 224 per stage on card 0249, against tens of thousands of output
 * tokens. A ceiling keyed on input would never trigger, so `EventLog.outputTokensSince` (the rollup
 * this setting is checked against) sums only `usage.outputTokens`, and the key is named
 * `daily-output-token-ceiling` rather than a more generic "token ceiling" so a reader does not have
 * to open this file to learn which count it bounds.
 *
 * `0`, the coded default, means no ceiling: `Poller.tickProject` and `BoardWriteService.start` both
 * skip `outputTokensSince` entirely when this reads `0`, so a fresh database and an unset environment
 * enqueue exactly as they did before this setting existed. There is deliberately no coded minimum
 * above zero enforced here — this card adds no `set()` and no HTTP surface for the value, unlike
 * `CARD_STAGE_CONCURRENCY`'s own `SettingService` — but an operator setting one by hand (a
 * `runner.settings` row, or this `envVar` directly) should stay well clear of zero: something on the
 * order of 10,000 or more, since anything close to a single stage's typical spend can pause a board
 * for the rest of the day on one attempt. A typo — an extra zero dropped, `1` instead of `10,000` —
 * is the exact failure this number exists to guard against, not something this setting should be able
 * to inflict on itself.
 *
 * `scope: 'project'` — a daily budget is a policy for one project's spend, the same reasoning
 * `DRY_RUN_ENABLED`'s doc comment gives for its own `'project'` scope: a project that has earned a
 * generous ceiling and a freshly registered one sitting on the same daemon are exactly the case a
 * deployment-wide row would erase the distinction between.
 *
 * Parsed like `CARD_STAGE_CONCURRENCY`: fail fast on a non-integer or negative environment value
 * rather than silently falling back to `0` (no ceiling), which would be the one env-var typo an
 * operator could make that this setting would never notice.
 */
export const DAILY_OUTPUT_TOKEN_CEILING: SettingDefinition<number> = {
    key: 'daily-output-token-ceiling',
    scope: 'project',
    envVar: 'DAILY_OUTPUT_TOKEN_CEILING',
    parseEnv: raw => {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error(`Invalid DAILY_OUTPUT_TOKEN_CEILING: "${raw}" is not a non-negative integer`);
        }
        return parsed;
    },
    defaultValue: 0,
};
