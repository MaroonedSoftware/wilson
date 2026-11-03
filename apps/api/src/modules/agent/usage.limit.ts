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

/** What the `codex` engine's errors call running out, as opposed to any other failure. */
const CODEX_LIMIT_ERRORS = new Set(['usageLimitExceeded', 'rateLimitExceeded']);

/**
 * The same watch for the `codex` engine, which reports a limit two ways. An account signed in to a plan
 * gets `account/rateLimits/updated`, saying when it resets. An API key gets only an error, so no reset
 * time. An error may be one the engine is still retrying, which `progress` then rules out.
 */
export class CodexLimitWatch {
    private fromSnapshot?: { limitType: string; resetsAt: number };
    private fromError?: { limitType: string; resetsAt: number };

    constructor(private readonly account: string) {}

    rateLimitsUpdated(snapshot: {
        rateLimitReachedType?: string | null;
        primary?: { resetsAt?: number | null } | null;
        secondary?: { resetsAt?: number | null } | null;
    }): void {
        if (!snapshot.rateLimitReachedType) {
            this.fromSnapshot = undefined;
            return;
        }
        // Without saying which window ran out, so the later of the two, rather than try again too soon.
        const resets = [snapshot.primary?.resetsAt, snapshot.secondary?.resetsAt].filter((at): at is number => typeof at === 'number');
        this.fromSnapshot = {
            limitType: snapshot.rateLimitReachedType,
            resetsAt: resets.length > 0 ? toMillis(Math.max(...resets)) : Date.now() + UNKNOWN_RESET_MS,
        };
    }

    error(error: { codexErrorInfo?: unknown } | null | undefined): void {
        const info = error?.codexErrorInfo;
        if (typeof info === 'string' && CODEX_LIMIT_ERRORS.has(info)) this.fromError = { limitType: info, resetsAt: Date.now() + UNKNOWN_RESET_MS };
    }

    /** The engine got something done, so an error seen before it was not the end of the account. */
    progress(): void {
        this.fromError = undefined;
    }

    /** The limit this run hit, if it has hit one. Only meaningful once the run has stopped. */
    get limit(): UsageLimit | undefined {
        const seen = this.fromSnapshot ?? this.fromError;
        return seen && { account: this.account, ...seen };
    }
}

/** A limit as a person reads it. */
export const describeUsageLimit = ({ account, limitType, resetsAt }: UsageLimit): string =>
    `the account "${account}" hit its ${limitType.replaceAll('_', '-')} usage limit, which resets at ${new Date(resetsAt).toISOString()}`;
