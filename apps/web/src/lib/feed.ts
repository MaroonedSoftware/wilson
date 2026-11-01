import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { JsonValue } from '@wilson/sdk';
import { API_BASE } from './sdk.js';

/** Whether the board is watching the live feed or showing whatever it last fetched. */
export type FeedStatus = 'live' | 'disconnected';

/**
 * Card 0274. The wire shape of an SSE `card` event, as `@maroonedsoftware/serverfeed`'s
 * `ServerFeed.status` publishes it (`card.feed.listener.ts`: `cardFeed.status(project, cardId, type,
 * { stage, payload })`) and `openCardFeedStream` serializes it (`card.feed.route.ts`). Hand-typed
 * rather than imported from that package: it is a server-only dependency, and this hand-shared shape
 * is already how the rest of the app treats the SSE contract (see `card.feed.event.ts`'s own doc
 * comment on the wire format being pure data with no framework tie). `message` is the event's own
 * type, `ts` its publish time, `correlationId` the card id, and `data` the `{ stage, payload }` pair
 * the listener publishes — never richer than that, since `ServerFeedEvent` carries nothing else this
 * app reads.
 */
interface WireCardEvent {
    id: number;
    ts: string;
    message?: string;
    correlationId?: string;
    data?: { stage?: string | null; payload?: JsonValue };
}

/**
 * Card 0274. The latest feed event published for one card — display state, not board state (see this
 * card's Constraints, and the doc comment on `useCardFeed` below): `type` is the event's own type,
 * `stage` is the stage it was recorded in, and `ts` is its own publish time, never the browser's
 * receipt time, so an event replayed in the connect snapshot still shows its true age.
 */
export interface CardActivity {
    type: string;
    stage: string | null;
    payload: JsonValue;
    ts: string;
}

/**
 * Card 0274. One `tool.executed`/`tool.denied`/`tool.unguarded` event for a card's live activity
 * list (`LiveActivity.tsx`). `id` is the feed's own monotonic sequence number — the only stable key
 * an SSE-delivered event carries, since the database row id `card.feed.listener.ts` reads `payload`
 * back by is never forwarded onto the wire.
 */
export interface FeedToolEvent {
    id: number;
    type: string;
    payload: JsonValue;
    ts: string;
}

/** Card 0274. `tool.*` event types this card's live list keeps a history of, and the tile's "skip
 * board invalidation" rule excludes — see `useCardFeed`'s listener below. An exclusion list, not an
 * allow list (this card's Constraints): any event type added later still invalidates by default. */
const TOOL_EVENT_TYPES = new Set(['tool.executed', 'tool.denied', 'tool.unguarded']);

/** Card 0274. How many of a card's own `tool.*` events `LiveActivity.tsx` keeps in memory — bounded
 * per this card's Constraints, so a long-running stage's tool list cannot grow without limit. */
export const MAX_LIVE_TOOL_EVENTS = 100;

/** Card 0274. The one shared clock a board tile's "last event" age and a card page's tool-call list
 * both read from (this card's Constraints: "one ticking interval for the whole app... not one per
 * tile") — see `useCardFeed`'s own ticking effect below. */
const ACTIVITY_TICK_MS = 10_000;

/** The cache key of one project's activity page, which the feed below keeps fresh. */
export const activityQueryKey = (project: string): string[] => ['project', project, 'activity'];

interface CardActivityValue {
    /** The latest feed event per card id, for a board tile's "last event" line. */
    activity: Record<string, CardActivity>;
    /** Each card's own `tool.*` history, newest first, capped at `MAX_LIVE_TOOL_EVENTS`. */
    toolLog: Record<string, FeedToolEvent[]>;
    /** Ticks every `ACTIVITY_TICK_MS` — read this instead of `new Date()` so a relative age re-renders
     * without a refetch. */
    now: Date;
}

const EMPTY_TOOL_LOG: FeedToolEvent[] = [];

/**
 * Card 0274. Carries `useCardFeed`'s `activity`/`toolLog`/`now` to whatever reads them —
 * `Board.tsx`'s tiles and `LiveActivity.tsx`'s live list — without either opening a second
 * `EventSource` (this card's Constraints: "one feed connection"). Provided once, from the single
 * `useCardFeed` call in `__root.tsx`, the same way the feed's `status`/`reconnect` already are.
 */
export const CardActivityContext = createContext<CardActivityValue>({ activity: {}, toolLog: {}, now: new Date(0) });

/** The latest feed event `cardId` has published, or `undefined` before any has arrived. */
export const useCardActivity = (cardId: string): CardActivity | undefined => useContext(CardActivityContext).activity[cardId];

/** `cardId`'s own `tool.*` history, newest first — never a fresh `[]` identity, so a consumer's
 * effects keyed on this don't re-fire every render for a card with no live tool events yet. */
export const useCardToolLog = (cardId: string): FeedToolEvent[] => useContext(CardActivityContext).toolLog[cardId] ?? EMPTY_TOOL_LOG;

/** The shared clock — ticks every ten seconds, see `ACTIVITY_TICK_MS` above. */
export const useActivityNow = (): Date => useContext(CardActivityContext).now;

/**
 * `useCardFeed`'s return value (card 0173). `status` is exactly what this hook always returned —
 * `FeedStatus` itself is untouched, so anything that only ever read the status string against a
 * pre-0173 tree still compiles against this same type. `reconnect` is the one thing this card adds:
 * the header's refresh affordance (`__root.tsx`) calls it instead of a tooltip that only ever told a
 * person to do this themselves, with no way here to actually do it.
 */
export interface CardFeed {
    status: FeedStatus;
    /** Invalidates every query and tears down and reopens the `EventSource` — for when the
     * connection dropped and the browser's own retry hasn't landed yet. Not optimistic anything: it
     * doesn't guess at what changed, it goes and asks. */
    reconnect: () => void;
    /**
     * Card 0274. `__root.tsx` feeds these three straight into `CardActivityContext.Provider` — see
     * that context's own doc comment for why this rides the same subscription rather than a second
     * `EventSource`.
     */
    activity: Record<string, CardActivity>;
    toolLog: Record<string, FeedToolEvent[]>;
    now: Date;
}

/**
 * Subscribes to `/api/feed` for the lifetime of the app and invalidates the cards query on every
 * event, so a card that moves shows up without anyone pressing refresh.
 *
 * Deliberately not a reducer that folds events into board state: the feed hands a fresh subscriber
 * the latest value per card on connect, so replaying the stream client-side would just rebuild what
 * the snapshot already gives for free. An event only ever means "go re-fetch the list" — the runner
 * is the sole writer, and rendering a client-side guess at the next state would render a lie.
 *
 * The browser's own retry already covers the common case: a plain `EventSource` reconnects on its
 * own after the connection drops (an API restart, most likely, since every restart drops every open
 * stream), and `onopen`/`onerror` are enough to track whether that retry has landed yet. Card 0173
 * adds `reconnect` (`CardFeed`, above) for when that hasn't happened yet and a person wants to force
 * it rather than wait — bumping `generation` below re-runs this effect exactly as a `project` change
 * already does, closing whatever `EventSource` is currently open and opening a new one.
 *
 * `project`, card 0153: `EventSource` cannot set `X-Wilson-Project`, so a project-scoped screen names
 * itself with `?project=` instead — the query fallback `routes.setup.ts`'s `ProjectContextRouter` now
 * accepts for exactly this reason. Left `undefined` (the default, from `__root.tsx` on every screen
 * that carries no `project` route param) the connection names none, resolving to the daemon's own
 * configured project exactly as it did before this card.
 *
 * Card 0154: the connection already names its project (above), so the server only ever delivers this
 * subscriber events for that one project (`FeedRouter`'s own `filter = { source: project }` in
 * `routes.setup.ts`) — but invalidating a fixed `['cards']` regardless would still miss the board
 * that is actually on screen. A `/projects/$project` screen (`projects.$project.index.tsx`) reads
 * `['project', project, 'cards']`, prefixed so its cache can never collide with another project's own
 * — invalidating that same key is what makes an event on screen actually refetch that screen's board,
 * and never another project's.
 *
 * The plain `['cards']` key is invalidated too, unconditionally, alongside the scoped one: card 0155
 * deleted the last route that read it as a board of its own (the top-level `/`), but `FlaggedIndicator`
 * (`__root.tsx`'s shared header) still reads it through the unscoped singleton client, on every screen,
 * regardless of which project is on screen — its own doc comment defers giving it a project-scoped
 * cache key to a later card. Dropping the plain-key invalidation here when a project is given would
 * silently break that badge's live count on every project-scoped screen, which this card's own
 * acceptance criteria rules out ("every screen behaves exactly as it does today"). Invalidating it
 * doesn't reopen the bug above: nothing left reads the plain key as a *board*, only this one
 * project-agnostic widget.
 *
 * Card 0274: this still never folds an event into board state — `stage`, flags and position still
 * come only from a refetch, exactly as the doc comment above requires. What changed is that the raw
 * event itself is now a fact worth keeping client-side too, alongside the "go re-fetch" it has always
 * triggered: the last one per card (`activity`, for a board tile's own "last event" line) and each
 * card's own recent `tool.*` history (`toolLog`, for `LiveActivity.tsx`'s live list on the card
 * page). Neither is folded into `['cards']`/`['card', id]` — both live in `CardActivityContext`
 * instead, read through `useCardActivity`/`useCardToolLog`/`useActivityNow` above. A `tool.*` event
 * still updates `activity` and `toolLog` the same as any other event; it just no longer invalidates
 * the cards query, since none of `tool.executed`/`tool.denied`/`tool.unguarded` changes anything
 * `CardSummary` carries (this card's Constraints — an exclusion list, so an event type added later
 * still invalidates by default).
 */
export const useCardFeed = (project?: string): CardFeed => {
    const queryClient = useQueryClient();
    const [status, setStatus] = useState<FeedStatus>('disconnected');
    // Bumped by `reconnect` below to force the effect to tear down the current `EventSource` and
    // open a fresh one — the same cleanup-then-recreate the effect already does on every `project`
    // change, just triggered by a click instead of a route change.
    const [generation, setGeneration] = useState(0);
    // Card 0274: `activity`/`toolLog` below.
    const [activity, setActivity] = useState<Record<string, CardActivity>>({});
    const [toolLog, setToolLog] = useState<Record<string, FeedToolEvent[]>>({});
    // Card 0274: the one shared clock `ACTIVITY_TICK_MS` names above — ticks for the lifetime of the
    // app, independent of `project`/`generation`, so switching projects or reconnecting never resets
    // it and nothing here opens a second interval.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), ACTIVITY_TICK_MS);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        // Card 0274: a fresh connection (a project switch, or `reconnect` below) starts both maps
        // empty rather than carrying a previous project's — or a previous connection's stale — cards
        // forward. `activity` is repopulated immediately from the snapshot every fresh subscriber
        // gets (`openCardFeedStream`'s own `feed.snapshot()` replay, one 'card' event per card); left
        // un-reset it would otherwise go on showing a card id that happens to belong to a different
        // project's board.
        setActivity({});
        setToolLog({});

        const url = project ? `${API_BASE}/api/feed?project=${encodeURIComponent(project)}` : `${API_BASE}/api/feed`;
        // `withCredentials`: an `EventSource` cannot send a bearer header, so it authenticates with the
        // API's stream cookie instead (`stream.cookie.middleware.ts` in apps/api).
        const source = new EventSource(url, { withCredentials: true });
        const cardsQueryKey = project ? ['project', project, 'cards'] : ['cards'];

        source.onopen = () => setStatus('live');
        source.onerror = () => setStatus('disconnected');
        source.addEventListener('card', raw => {
            const event = parseWireCardEvent(raw as MessageEvent<string>);
            if (!event) return;

            const type = event.message ?? '';
            const cardId = event.correlationId;
            if (cardId) {
                const stage = event.data?.stage ?? null;
                const payload = event.data?.payload ?? null;
                setActivity(current => ({ ...current, [cardId]: { type, stage, payload, ts: event.ts } }));
                if (TOOL_EVENT_TYPES.has(type)) {
                    setToolLog(current => {
                        const existing = current[cardId] ?? EMPTY_TOOL_LOG;
                        const entry: FeedToolEvent = { id: event.id, type, payload, ts: event.ts };
                        return { ...current, [cardId]: [entry, ...existing].slice(0, MAX_LIVE_TOOL_EVENTS) };
                    });
                }
            }

            // Card 0274: a `tool.*` event changes nothing `CardSummary` carries — see this hook's own
            // doc comment above and `TOOL_EVENT_TYPES`'s.
            if (TOOL_EVENT_TYPES.has(type)) return;
            void queryClient.invalidateQueries({ queryKey: cardsQueryKey });
            if (project) void queryClient.invalidateQueries({ queryKey: ['cards'] });
        });

        return () => source.close();
    }, [queryClient, project, generation]);

    const reconnect = useCallback(() => {
        void queryClient.invalidateQueries();
        setStatus('disconnected');
        setGeneration(generationValue => generationValue + 1);
    }, [queryClient]);

    return { status, reconnect, activity, toolLog, now };
};

/** Card 0274. `raw.data` is the JSON text `openCardFeedStream` wrote for a `card` SSE event
 * (`stream.event({ event: 'card', data: event })`, itself JSON-stringified by the SSE transport) —
 * parsed defensively since nothing upstream of this hook validates it against `WireCardEvent`. */
const parseWireCardEvent = (raw: MessageEvent<string>): WireCardEvent | undefined => {
    try {
        return JSON.parse(raw.data) as WireCardEvent;
    } catch {
        return undefined;
    }
};
