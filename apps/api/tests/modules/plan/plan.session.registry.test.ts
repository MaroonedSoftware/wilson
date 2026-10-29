import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanTurnRepository } from '#modules/plan/plan.turn.repository.js';

/**
 * Card 0132: `planSessions` is the in-process map of card id to live planning session, plus the
 * idle timeout that disposes one. `PlanSessionAgent` itself is exercised by
 * `plan.session.agent.test.ts`; here it is replaced with a bare double so this file can test the
 * registry's own job in isolation — resolving `resume` on a miss, reusing a live session on a hit,
 * and disposing an idle one — without spinning up a real engine.
 */
const { PlanSessionAgentMock, ctorCalls, disposeMock } = vi.hoisted(() => {
    const ctorCalls: unknown[] = [];
    const disposeMock = vi.fn();
    class PlanSessionAgentMock {
        readonly options: unknown;
        constructor(options: unknown) {
            this.options = options;
            ctorCalls.push(options);
        }
        dispose(): void {
            disposeMock(this);
        }
    }
    return { PlanSessionAgentMock, ctorCalls, disposeMock };
});

vi.mock('#modules/agent/plan.session.agent.js', () => ({ PlanSessionAgent: PlanSessionAgentMock }));

const { planSessions } = await import('#modules/plan/plan.session.registry.js');

/** Never resolves any card to a stored session, and records whether it was asked. */
const noHistoryRepo = (): PlanTurnRepository => {
    const calls: string[] = [];
    return {
        latestEngineSessionId: vi.fn(async (cardId: string) => {
            calls.push(cardId);
            return undefined;
        }),
        // A registry that ever replayed stored turns into the prompt would have to read them from
        // here — asserting this is never called is the other half of "does not replay stored turns".
        since: vi.fn(),
        append: vi.fn(),
    } as unknown as PlanTurnRepository;
};

const withStoredSession = (sessionId: string): PlanTurnRepository =>
    ({
        latestEngineSessionId: vi.fn(async () => sessionId),
        since: vi.fn(),
        append: vi.fn(),
    }) as unknown as PlanTurnRepository;

const request = { worktreeRoot: '/tmp/worktree', model: 'claude-opus' };

describe('planSessions', () => {
    afterEach(() => {
        ctorCalls.length = 0;
        disposeMock.mockClear();
        vi.useRealTimers();
    });

    it('opens a brand-new conversation for a card with no stored turns', async () => {
        const cardId = `card-fresh-${Math.random()}`;
        try {
            const repo = noHistoryRepo();
            await planSessions.session(cardId, request, repo);

            expect(repo.latestEngineSessionId).toHaveBeenCalledWith(cardId);
            expect(ctorCalls).toEqual([{ ...request, resume: undefined }]);
        } finally {
            planSessions.dispose(cardId);
        }
    });

    it('resumes the recorded engine session on a miss for a card that has stored turns', async () => {
        const cardId = `card-resume-${Math.random()}`;
        try {
            const repo = withStoredSession('engine-session-42');
            await planSessions.session(cardId, request, repo);

            expect(ctorCalls).toEqual([{ ...request, resume: 'engine-session-42' }]);
        } finally {
            planSessions.dispose(cardId);
        }
    });

    it('never replays stored turns into the prompt: only latestEngineSessionId is ever consulted', async () => {
        const cardId = `card-no-replay-${Math.random()}`;
        try {
            const repo = withStoredSession('engine-session-1');
            await planSessions.session(cardId, request, repo);

            expect(repo.since).not.toHaveBeenCalled();
            expect(repo.append).not.toHaveBeenCalled();
        } finally {
            planSessions.dispose(cardId);
        }
    });

    it('returns the same live session on a hit, without constructing a second one or touching the repository again', async () => {
        const cardId = `card-hit-${Math.random()}`;
        try {
            const repo = noHistoryRepo();
            const first = await planSessions.session(cardId, request, repo);
            const second = await planSessions.session(cardId, request, repo);

            expect(second).toBe(first);
            expect(ctorCalls).toHaveLength(1);
            expect(repo.latestEngineSessionId).toHaveBeenCalledTimes(1);
        } finally {
            planSessions.dispose(cardId);
        }
    });

    it('disposes an idle session after the idle timeout, without touching the turns repository', async () => {
        vi.useFakeTimers();
        const cardId = `card-idle-${Math.random()}`;
        const repo = noHistoryRepo();
        const agent = await planSessions.session(cardId, request, repo);

        const IDLE_MS = 30 * 60 * 1000;
        await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
        expect(disposeMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(disposeMock).toHaveBeenCalledWith(agent);
        // Disposal is an in-memory teardown only; it must never read or write `wilson.plan_turns`.
        expect(repo.since).not.toHaveBeenCalled();
        expect(repo.append).not.toHaveBeenCalled();
    });

    it('refreshes the idle timeout on a hit, so activity keeps a session alive past the original deadline', async () => {
        vi.useFakeTimers();
        const cardId = `card-bump-${Math.random()}`;
        const repo = noHistoryRepo();
        await planSessions.session(cardId, request, repo);

        const IDLE_MS = 30 * 60 * 1000;
        // Touch the session just before it would have been disposed, resetting the clock.
        await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
        await planSessions.session(cardId, request, repo);
        await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);

        // Had the bump not reset the timer, the session would already be gone by now.
        expect(disposeMock).not.toHaveBeenCalled();
        expect(ctorCalls).toHaveLength(1);

        planSessions.dispose(cardId);
    });

    it('dispose is idempotent for a card with no live session', () => {
        expect(() => planSessions.dispose('card-never-opened')).not.toThrow();
        expect(disposeMock).not.toHaveBeenCalled();
    });

    it('dropping a live session via dispose lets a later call open a fresh one instead of reusing the disposed agent', async () => {
        const cardId = `card-redispose-${Math.random()}`;
        const repo = noHistoryRepo();
        const first = await planSessions.session(cardId, request, repo);

        planSessions.dispose(cardId);
        expect(disposeMock).toHaveBeenCalledWith(first);

        const second = await planSessions.session(cardId, request, repo);
        expect(second).not.toBe(first);
        expect(ctorCalls).toHaveLength(2);

        planSessions.dispose(cardId);
    });
});
