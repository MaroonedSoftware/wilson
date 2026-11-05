import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * generated from [AppV1DoneReason](../../../../apps/api/data/contracts/app.api.ck)
 */
export type AppV1DoneReason = 'merged' | 'poisoned' | 'dropped' | 'split';

/**
 * What pressing Merge on a `ready` card would do right now.
 * generated from [AppV1MergeStatus](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1MergeStatus {
    state: 'clean' | 'conflict' | 'rereview' | 'capped' | 'unknown';
    target?: string;
    conflicts: string[];
    movedUnder: string[];
    reason?: string;
}

/**
 * The question a stage stopped to ask.
 * generated from [AppV1CardBlocked](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1CardBlocked {
    category: 'decision' | 'access' | 'requirements' | 'environment' | 'other';
    tried: string;
    question: string;
    options?: string[];
    stage: string;
    askedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a AppV1CardBlocked into its runtime type. Mutates and returns `raw`. */
export function reviveAppV1CardBlocked(raw: AppV1CardBlocked): AppV1CardBlocked {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['askedAt'] = __dt(__o0['askedAt'], 'AppV1CardBlocked.askedAt');
    return raw;
}

/**
 * generated from [AppV1BoardColumns](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1BoardColumns {
    stages: string[];
    nonStages: string[];
}

/**
 * One thing that happened on the project, without the event's own payload, whose shape belongs to the event
 * log. `cardTitle` is null when the card no longer exists.
 * generated from [AppV1ActivityEvent](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1ActivityEvent {
    id: string;
    cardId: string;
    cardTitle: string | null;
    type: string;
    stage: string | null;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a AppV1ActivityEvent into its runtime type. Mutates and returns `raw`. */
export function reviveAppV1ActivityEvent(raw: AppV1ActivityEvent): AppV1ActivityEvent {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'AppV1ActivityEvent.createdAt');
    return raw;
}

/**
 * generated from [AppV1ActivityQuery](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1ActivityQuery {
    limit?: number;
    before?: number;
}

/**
 * generated from [AppV1StatsQuery](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1StatsQuery {
    days?: number;
}

/**
 * generated from [AppV1StatsCounts](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1StatsCounts {
    attempts: number;
    passed: number;
    failed: number;
    interrupted: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
}

/**
 * generated from [AppV1ConversationStats](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1ConversationStats {
    kind: 'planning' | 'review';
    turns: number;
    cards: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
}

/**
 * generated from [AppV1SplitPiece](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1SplitPiece {
    id: string;
    title: string;
    stage: string;
    doneReason?: AppV1DoneReason;
}

/**
 * generated from [AppV1Card](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1Card {
    id: string;
    title: string;
    stage: string;
    doneReason?: AppV1DoneReason;
    planCheck?: 'checking' | 'refused';
    planCheckReason?: string;
    /** The branch the card's work is on, whether recorded or derived from its title. */
    branch?: string;
    dependsOn: string[];
    needsHuman: boolean;
    needsHumanReason?: string;
    blocked?: AppV1CardBlocked;
    position?: number;
    splitFrom?: string;
    stageEnteredAt?: DateTime;
    mergeStatus?: AppV1MergeStatus;
}

/** Rehydrates every wire-encoded scalar in a AppV1Card into its runtime type. Mutates and returns `raw`. */
export function reviveAppV1Card(raw: AppV1Card): AppV1Card {
    const __o0 = raw as unknown as Record<string, unknown>;
    if (__o0['blocked'] != null) {
        reviveAppV1CardBlocked(__o0['blocked'] as never);
    }
    if (__o0['stageEnteredAt'] != null) {
        __o0['stageEnteredAt'] = __dt(__o0['stageEnteredAt'], 'AppV1Card.stageEnteredAt');
    }
    return raw;
}

/**
 * generated from [AppV1StageStats](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1StageStats extends AppV1StatsCounts {
    stage: string;
    cards: number;
}

/**
 * generated from [AppV1DayStats](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1DayStats extends AppV1StatsCounts {
    date: string;
}

/**
 * generated from [AppV1CardStats](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1CardStats extends AppV1StatsCounts {
    cardId: string;
    cardTitle?: string;
}

/**
 * generated from [AppV1StatsTotal](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1StatsTotal extends AppV1StatsCounts {
    cards: number;
}

/**
 * generated from [AppV1CardDetail](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1CardDetail extends AppV1Card {
    body: string;
    sections: Record<string, string>;
    pieces?: AppV1SplitPiece[];
}

/** Rehydrates every wire-encoded scalar in a AppV1CardDetail into its runtime type. Mutates and returns `raw`. */
export function reviveAppV1CardDetail(raw: AppV1CardDetail): AppV1CardDetail {
    reviveAppV1Card(raw as never);
    return raw;
}

/**
 * generated from [AppV1Stats](../../../../apps/api/data/contracts/app.api.ck)
 */
export interface AppV1Stats {
    since: DateTime;
    until: DateTime;
    zone: string;
    total: AppV1StatsTotal;
    stages: AppV1StageStats[];
    days: AppV1DayStats[];
    topCards: AppV1CardStats[];
    conversations: AppV1ConversationStats[];
}

/** Rehydrates every wire-encoded scalar in a AppV1Stats into its runtime type. Mutates and returns `raw`. */
export function reviveAppV1Stats(raw: AppV1Stats): AppV1Stats {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['since'] = __dt(__o0['since'], 'AppV1Stats.since');
    __o0['until'] = __dt(__o0['until'], 'AppV1Stats.until');
    return raw;
}
