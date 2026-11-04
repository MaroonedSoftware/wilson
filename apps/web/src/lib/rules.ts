import type { CardEvent } from '@wilson/sdk';

export type RuleVerdictValue = 'pass' | 'fail' | 'unavailable';

/** One rule's verdict, as far as a card needs it. */
export interface CardRuleVerdict {
    rule: string;
    statement?: string;
    severity?: string;
    verdict: RuleVerdictValue;
    file?: string;
    line?: number;
    evidence: string;
}

const isVerdict = (value: unknown): value is RuleVerdictValue => value === 'pass' || value === 'fail' || value === 'unavailable';

/**
 * The `verdicts` of one `rule.verdicts` event, narrowed by hand, since `CardEvent.payload` carries no
 * per-`type` union on the wire. An entry that is not one is left out rather than breaking the page.
 */
const verdictsFromPayload = (payload: unknown): CardRuleVerdict[] => {
    const verdicts = (payload as { verdicts?: unknown } | undefined)?.verdicts;
    if (!Array.isArray(verdicts)) return [];
    return verdicts.flatMap((entry: unknown): CardRuleVerdict[] => {
        const { rule, statement, severity, verdict, file, line, evidence } = (entry ?? {}) as Record<string, unknown>;
        if (typeof rule !== 'string' || !isVerdict(verdict)) return [];
        return [
            {
                rule,
                verdict,
                evidence: typeof evidence === 'string' ? evidence : '',
                ...(typeof statement === 'string' ? { statement } : {}),
                ...(typeof severity === 'string' ? { severity } : {}),
                ...(typeof file === 'string' ? { file } : {}),
                ...(typeof line === 'number' ? { line } : {}),
            },
        ];
    });
};

/** What the judges last said about a card, from its newest `rule.verdicts`. `events` arrive oldest first. */
export const latestRuleVerdicts = (events: readonly CardEvent[] | undefined): CardRuleVerdict[] => {
    if (!events) return [];
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.type === 'rule.verdicts') return verdictsFromPayload(events[i]!.payload);
    }
    return [];
};

/** Globs as a person types them, one per line or separated by spaces. A brace can hold a comma, so commas stay. */
export const parseGlobs = (text: string): string[] => text.split(/\s+/).filter(Boolean);
