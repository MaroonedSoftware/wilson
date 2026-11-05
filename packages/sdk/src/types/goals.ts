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
 * generated from [Goal](../../../../apps/api/data/contracts/goals.ck)
 */
export interface Goal {
    id: string;
    threadId: string;
    project: string;
    title: string;
    /** What done looks like, in the person's terms. */
    outcome: string;
    status: 'active' | 'paused' | 'done' | 'abandoned';
    createdAt: DateTime;
    updatedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a Goal into its runtime type. Mutates and returns `raw`. */
export function reviveGoal(raw: Goal): Goal {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'Goal.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'Goal.updatedAt');
    return raw;
}

/**
 * A card as a goal shows it.
 * generated from [GoalCard](../../../../apps/api/data/contracts/goals.ck)
 */
export interface GoalCard {
    id: string;
    title: string;
    stage: string;
    needsHuman: boolean;
}

/**
 * generated from [ListGoalsQuery](../../../../apps/api/data/contracts/goals.ck)
 */
export interface ListGoalsQuery {
    project?: string;
    status?: 'active' | 'paused' | 'done' | 'abandoned';
    threadId?: string;
}

/**
 * generated from [CreateGoalRequest](../../../../apps/api/data/contracts/goals.ck)
 */
export interface CreateGoalRequest {
    /** The thread that sees it through, which has no goal yet. */
    threadId: string;
    project: string;
    title: string;
    outcome: string;
}

/**
 * generated from [UpdateGoalRequest](../../../../apps/api/data/contracts/goals.ck)
 */
export interface UpdateGoalRequest {
    title?: string;
    outcome?: string;
    status?: 'active' | 'paused' | 'done' | 'abandoned';
}

/**
 * generated from [GoalDetail](../../../../apps/api/data/contracts/goals.ck)
 */
export interface GoalDetail {
    goal: Goal;
    cards: GoalCard[];
}

/** Rehydrates every wire-encoded scalar in a GoalDetail into its runtime type. Mutates and returns `raw`. */
export function reviveGoalDetail(raw: GoalDetail): GoalDetail {
    const __o0 = raw as unknown as Record<string, unknown>;
    reviveGoal(__o0['goal'] as never);
    return raw;
}
