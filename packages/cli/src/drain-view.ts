import type { DrainStatus } from '@wilson/sdk';

/** One line on where a drain stands, shared by `wilson server drain`, `resume` and `status`. */
export const describeDrain = (status: DrainStatus): string => {
    const running = status.running.map(({ project, cardId }) => `${project}/${cardId}`).join(', ');
    const state = status.safeToRestart ? 'draining, safe to restart' : status.draining ? 'draining' : 'not draining';
    return `${state} · running ${status.running.length}${running ? ` (${running})` : ''} · held ${status.held} · plan drafts ${status.planDrafts}`;
};
