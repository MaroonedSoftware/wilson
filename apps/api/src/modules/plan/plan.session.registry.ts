import { PlanSessionAgent, type PlanSessionOptions } from '#modules/agent/plan.session.agent.js';
import type { PlanTurnRepository } from './plan.turn.repository.js';

/**
 * How long a card's live session may sit unused before it is torn down. There is no per-turn or
 * wall-clock budget for a planning conversation (this card's Constraints) — this is the one cutoff
 * it gets, and it is generous on purpose: the other side of a turn is a person reading a reply and
 * composing the next one, not an automated loop, so the gap between turns is real thinking time,
 * not idleness to charge against a budget.
 */
const IDLE_MS = 30 * 60 * 1000;

interface SessionEntry {
    agent: PlanSessionAgent;
    idle: NodeJS.Timeout;
}

/** What a caller supplies to open or rejoin a card's session — everything `PlanSessionOptions`
 * needs except `resume`, which this registry resolves itself on a miss (see `session` below). */
export type PlanSessionRequest = Omit<PlanSessionOptions, 'resume'>;

/**
 * The in-process map of card id to live planning session, plus the idle timeout that disposes one.
 *
 * A plain module-level singleton, not a DI registration — the same reasoning `card.feed.ts` gives
 * for `cardFeed`, and doubly so here: a caller like `PlanService` is registered `asTransient()`, so
 * a new instance is constructed on every request. Holding this map as one of its constructor fields
 * would hand every request a fresh, empty registry — the exact bug this file exists to avoid. A
 * module-level `const` is constructed once, at import time, and outlives every transient caller.
 *
 * Rehydration lives here, not in the caller: `session` takes a `PlanTurnRepository` — which has no
 * DI registration of its own (see its class doc comment: "every caller already holds the two
 * constructor arguments") — and on a miss asks it for the card's last `engine_session_id` before
 * ever constructing a fresh `PlanSessionAgent`. A hit never touches `turns` at all: the live agent
 * already *is* the conversation, and asking the transcript table something the in-memory session
 * already knows would be a second, needless source of truth.
 */
class PlanSessionRegistry {
    private readonly sessions = new Map<string, SessionEntry>();

    /**
     * The live session for a card, constructing one if this map holds none — refreshing the idle
     * timeout either way, since a hit is itself a sign of use.
     *
     * A miss resumes the recorded engine session rather than opening a fresh conversation when
     * `turns` has one on record for this card, and never replays the stored turns themselves into
     * the prompt — the engine's own session file is what carries that history forward, exactly as
     * this card's Constraints require. A card with no stored turns yet (`latestEngineSessionId`
     * resolves to `undefined`) gets a brand-new conversation, indistinguishable from any other.
     */
    async session(cardId: string, request: PlanSessionRequest, turns: PlanTurnRepository): Promise<PlanSessionAgent> {
        const entry = this.sessions.get(cardId);
        if (entry) {
            this.bump(cardId, entry);
            return entry.agent;
        }

        const resume = await turns.latestEngineSessionId(cardId);
        const agent = new PlanSessionAgent({ ...request, resume });
        this.sessions.set(cardId, { agent, idle: this.schedule(cardId) });
        return agent;
    }

    /** Tear a card's live session down and drop it from the map. Idempotent: safe to call for a
     * card with no live session (a session that was opened but never conversed with, or closed
     * twice). Leaves `wilson.plan_turns` untouched — this only ever disposes the in-memory engine
     * process, never the stored transcript, which is what lets a later turn resume it. */
    dispose(cardId: string): void {
        const entry = this.sessions.get(cardId);
        if (!entry) return;
        clearTimeout(entry.idle);
        entry.agent.dispose();
        this.sessions.delete(cardId);
    }

    private bump(cardId: string, entry: SessionEntry): void {
        clearTimeout(entry.idle);
        entry.idle = this.schedule(cardId);
    }

    private schedule(cardId: string): NodeJS.Timeout {
        const timer = setTimeout(() => this.dispose(cardId), IDLE_MS);
        // Never keeps the process up on its own — the same reasoning `cli.stage.agent.ts`'s own
        // timers give, just for a much longer window.
        timer.unref();
        return timer;
    }
}

export const planSessions = new PlanSessionRegistry();
