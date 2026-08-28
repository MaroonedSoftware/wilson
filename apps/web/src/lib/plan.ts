import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useListState } from '@mantine/hooks';
import type { PlanDraft, PlanTurn } from '@wilson/sdk';
import { API_BASE, wilson } from './sdk.js';

/** Whether the conversation stream is watching live, still connecting, or has dropped. */
export type PlanStreamStatus = 'connecting' | 'live' | 'disconnected';

export interface PlanTranscript {
    /** Every turn the server has recorded for this card, oldest first, deduplicated by `seq`. */
    turns: PlanTurn[];
    /**
     * Assistant text arriving for the turn currently in flight, if any — the raw `delta` chunks
     * concatenated in arrival order. Cleared once that turn's own persisted `PlanTurn` lands, via a
     * replayed `turn` event or a caller's `commitTurn`.
     */
    pendingText: string;
    status: PlanStreamStatus;
    /** Set only once the stream has failed without ever having opened — see the hook's doc comment. */
    error: string | undefined;
    /**
     * Folds a turn the server handed back directly — `sendAPlanTurn`'s response — into the
     * transcript, the same way a replayed `turn` event would. Lets the sender see its own
     * completed reply without waiting on a reconnect, while every other subscriber still only ever
     * learns of it by reconnecting and being replayed to (the two paths this card's Constraints
     * allow: "the stream and the turns the server returns").
     */
    commitTurn: (turn: PlanTurn) => void;
}

const insertBySeq = (turns: PlanTurn[], turn: PlanTurn): PlanTurn[] =>
    turns.some(existing => existing.seq === turn.seq) ? turns : [...turns, turn].sort((a, b) => a.seq - b.seq);

/**
 * Subscribes to a card's planning conversation over `GET /api/cards/:id/plan/stream`, following
 * `useCardFeed` (`feed.ts`): a plain `EventSource`, no hand-rolled reconnect loop. The browser
 * retries a dropped connection on its own and resends `Last-Event-ID`, which is exactly the replay
 * card 0133 built server-side — this hook only ever reads what arrives, never manages reconnection.
 *
 * One subscription per mount, closed and reopened whenever `cardId` changes or the stream is
 * disabled. The transcript starts empty on every (re)connect and is rebuilt entirely from what the
 * server replays plus whatever `commitTurn` is handed afterward — never carried across a remount by
 * component state, so reloading mid-conversation restores the real transcript rather than whatever
 * a stale reducer happened to accumulate.
 *
 * Two SSE events arrive (`routes.setup.ts`'s `PlanStreamRouter`): `turn` — a full, persisted
 * `PlanTurn`, JSON-encoded since `SseFrame` only sends a string payload verbatim — replayed for
 * everything after the client's `Last-Event-ID` on connect; and `delta` — a raw text chunk of the
 * assistant reply still being produced, sent as that literal string, with no id of its own to
 * resume from. A client that drops mid-reply picks the finished turn back up from `turn`'s own
 * replay once the assistant is done, rather than resuming a partial chunk.
 *
 * `enabled` lets a caller (`CardDetailView`, for a card in `planning` only) skip opening the stream
 * for every other stage while still calling this hook unconditionally, honouring the rules of hooks.
 */
export function usePlanTranscript(cardId: string, enabled: boolean): PlanTranscript {
    const [turns, turnHandlers] = useListState<PlanTurn>([]);
    const [pendingText, setPendingText] = useState('');
    const [status, setStatus] = useState<PlanStreamStatus>('connecting');
    const [error, setError] = useState<string | undefined>(undefined);
    const hasOpenedRef = useRef(false);

    useEffect(() => {
        if (!enabled) return;

        turnHandlers.setState([]);
        setPendingText('');
        setStatus('connecting');
        setError(undefined);
        hasOpenedRef.current = false;

        const source = new EventSource(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/plan/stream`);

        source.onopen = () => {
            hasOpenedRef.current = true;
            setStatus('live');
            setError(undefined);
        };
        // A drop the browser will itself retry reads the same as a stream that never opened at all
        // here — either way there is nothing live right now, and only the "never opened" case gets
        // a message, so a transient reconnect after a long-lived session doesn't flash an alert.
        source.onerror = () => {
            setStatus('disconnected');
            if (!hasOpenedRef.current) setError('Could not connect to the planning conversation.');
        };
        source.addEventListener('turn', event => {
            const turn = JSON.parse((event as MessageEvent<string>).data) as PlanTurn;
            turnHandlers.setState(previous => insertBySeq(previous, turn));
            setPendingText('');
        });
        source.addEventListener('delta', event => {
            setPendingText(previous => previous + (event as MessageEvent<string>).data);
        });

        return () => source.close();
    }, [cardId, enabled]);

    const commitTurn = (turn: PlanTurn): void => {
        turnHandlers.setState(previous => insertBySeq(previous, turn));
        setPendingText('');
    };

    return { turns, pendingText, status, error, commitTurn };
}

/** How often `DraftPane` asks for `draft.md` again while its session is open. */
const DRAFT_POLL_MS = 4_000;

/**
 * A card's current draft (`GET .../plan/draft`, card 0140) — `draft.md`'s content, never the
 * server-local `draftPath` a browser cannot read (see `PlanDraft`'s own doc, `@wilson/sdk`).
 *
 * Polled, not pushed: `usePlanTranscript`'s `plan/stream` carries conversation turns and deltas,
 * not the draft file, and this card's Constraints call a second SSE stream for draft changes a
 * larger decision than this card should make. Re-fetching on an interval is what "follow the
 * agent's writes" reduces to here — `DraftPane.tsx` is the one thing responsible for not letting a
 * poll landing mid-edit blow away what a person is typing.
 */
export function usePlanDraft(cardId: string, enabled: boolean) {
    return useQuery({
        queryKey: ['plan-draft', cardId],
        queryFn: (): Promise<PlanDraft> => wilson.board.getAPlanDraft(cardId),
        enabled,
        refetchInterval: enabled ? DRAFT_POLL_MS : false,
    });
}
