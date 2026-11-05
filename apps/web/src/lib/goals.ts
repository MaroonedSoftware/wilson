import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Goal, GoalDetail, UpdateGoalRequest } from '@wilson/sdk';
import { useWilsonSdk } from './sdk-context.js';

export const GOALS_KEY = ['goals'] as const;
export const goalKey = (id: string) => ['goals', id] as const;
export const threadGoalKey = (threadId: string) => ['goals', 'thread', threadId] as const;

/** How often goals are re-read. The card feed is per project and a goal's page may have none open, so this polls. */
export const GOAL_REFRESH_MS = 10_000;

/** Every goal, most recently changed first. */
export function useGoals() {
    const wilson = useWilsonSdk();
    return useQuery({ queryKey: GOALS_KEY, queryFn: () => wilson.goals.listGoals(), refetchInterval: GOAL_REFRESH_MS });
}

/** One goal with its cards. */
export function useGoal(id: string) {
    const wilson = useWilsonSdk();
    return useQuery<GoalDetail>({ queryKey: goalKey(id), queryFn: () => wilson.goals.getAGoal(id), refetchInterval: GOAL_REFRESH_MS });
}

/** The goal a thread sees through, `undefined` when it has none. An undefined `threadId` reads nothing. */
export function useThreadGoal(threadId: string | undefined) {
    const wilson = useWilsonSdk();
    return useQuery<Goal | null>({
        queryKey: threadGoalKey(threadId ?? ''),
        queryFn: async () => (await wilson.goals.listGoals({ threadId: threadId! }))[0] ?? null,
        enabled: threadId !== undefined,
        refetchInterval: GOAL_REFRESH_MS,
    });
}

/** Changes a goal, a person's own act, so it needs no proposal. A refusal is left on `error`. */
export function useUpdateGoal(id: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (changes: UpdateGoalRequest) => wilson.goals.updateAGoal(id, changes),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: GOALS_KEY }),
    });
}

/** Whether a goal is still being worked. */
export const isOpen = (goal: Pick<Goal, 'status'>): boolean => goal.status === 'active' || goal.status === 'paused';

/** The colour a goal's status is shown in. */
export const statusColor = (status: Goal['status']): string => ({ active: 'green', paused: 'yellow', done: 'blue', abandoned: 'gray' })[status];
