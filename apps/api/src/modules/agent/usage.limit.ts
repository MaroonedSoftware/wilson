import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** An account that cannot run an engine until `resetsAt`, in milliseconds since the epoch. */
export interface UsageLimit {
    account: string;
    limitType: string;
    resetsAt: number;
}

/** How long to leave an account alone when the engine refused it without saying when it resets. */
const UNKNOWN_RESET_MS = 15 * 60_000;

/** What the engine's own result says when it reports a limit as a finished turn rather than an error. */
const LIMIT_TEXT = /hit your .*limit|usage limit/i;

/** The engine reports `resetsAt` in seconds. Anything already this large is milliseconds. */
const toMillis = (at: number): number => (at < 1e12 ? at * 1000 : at);

/**
 * Watches an engine's stream for its account running out. Nothing here ends the run: the engine goes
 * on to end its own turn, and the caller decides what that ending means, since a stage that has
 * already reported its result has finished whatever the account's state.
 */
export class UsageLimitWatch {
    private seen?: { limitType: string; resetsAt: number };

    constructor(private readonly account: string) {}

    observe(message: SDKMessage): void {
        if (message.type === 'rate_limit_event') {
            const { status, overageStatus, isUsingOverage, rateLimitType, resetsAt } = message.rate_limit_info;
            if (status === 'allowed') this.seen = undefined;
            // Past the plan's limit but paying for overage, the engine carries on.
            const overage = isUsingOverage === true || overageStatus === 'allowed' || overageStatus === 'allowed_warning';
            if (status === 'rejected' && !overage) {
                this.seen = {
                    limitType: rateLimitType ?? 'unknown',
                    resetsAt: resetsAt === undefined ? Date.now() + UNKNOWN_RESET_MS : toMillis(resetsAt),
                };
            }
            return;
        }
        if (this.seen) return;
        const refused =
            (message.type === 'assistant' && message.error === 'rate_limit') ||
            (message.type === 'result' && message.subtype === 'success' && message.is_error && LIMIT_TEXT.test(message.result));
        if (refused) this.seen = { limitType: 'unknown', resetsAt: Date.now() + UNKNOWN_RESET_MS };
    }

    /** The limit this run hit, if it has hit one. */
    get limit(): UsageLimit | undefined {
        return this.seen && { account: this.account, ...this.seen };
    }
}

/** A limit as a person reads it. */
export const describeUsageLimit = ({ account, limitType, resetsAt }: UsageLimit): string =>
    `the account "${account}" hit its ${limitType.replaceAll('_', '-')} usage limit, which resets at ${new Date(resetsAt).toISOString()}`;
