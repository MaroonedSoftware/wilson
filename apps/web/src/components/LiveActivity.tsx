import { useMemo } from 'react';
import { Badge, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import type { CardEvent } from '@wilson/sdk';
import { lastEventAge } from '#src/lib/board.js';
import { MAX_LIVE_TOOL_EVENTS, useActivityNow, useCardToolLog, type FeedToolEvent } from '#src/lib/feed.js';

/** Bounds the scroll region so a long-running stage's list doesn't push the rest of the card page
 * down the further it runs — the same fixed-height reasoning `PlanningPanes`' `PANE_HEIGHT` already
 * follows (`CardDetail.tsx`), just sized for a row of badges rather than a whole conversation. */
const LIST_HEIGHT = 240;

/** A `tool.*` event's own payload, read defensively: nothing upstream validates its shape against
 * `card.event.ts`'s own union of `{ tool, command? }` (bash), `{ tool, path? }` (write/edit/delete)
 * or `{ tool, reason, ... }` (a denial) — see `bash.tool.ts`/`file.tools.ts`/`cli.stage.agent.ts`'s
 * own `payload` literals for each shape this reads. */
const readPayload = (payload: unknown): Record<string, unknown> =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};

/** The tool a `tool.*` event named, e.g. `bash`, `write`, or the engine's own `Bash`/`Write`/`Edit`
 * spelling for the `cli` adapter (`cli.stage.agent.ts`'s `READ_TOOLS`/`WRITE_TOOLS`/`EXEC_TOOLS`) —
 * shown exactly as recorded rather than normalized, since either is already a name an operator
 * reading the card's own event log would recognise. */
const eventTool = (payload: unknown): string => {
    const tool = readPayload(payload).tool;
    return typeof tool === 'string' && tool ? tool : 'tool';
};

/**
 * The short label this card's plan asks for: the command for a shell call, the path for a file
 * tool, the reason for a denial. `tool.denied`'s own payload always carries `reason` (the allowlist
 * or scope guard's own sentence — `command.allowlist.ts`/`scope.guard.ts`); `tool.executed` and
 * `tool.unguarded` never do, so `command`/`path` is what is left to show for either.
 */
const eventLabel = (type: string, payload: unknown): string => {
    const p = readPayload(payload);
    if (type === 'tool.denied' && typeof p.reason === 'string' && p.reason) return p.reason;
    if (typeof p.command === 'string' && p.command) return p.command;
    if (typeof p.path === 'string' && p.path) return p.path;
    return '';
};

interface ActivityRow {
    key: string;
    tool: string;
    label: string;
    ts: string;
}

const toRow = (key: string, type: string, payload: unknown, ts: string): ActivityRow => ({
    key,
    tool: eventTool(payload),
    label: eventLabel(type, payload),
    ts,
});

/**
 * Card 0274. Combines `seedEvents` — the card's already-fetched event tail (`CardDetailView`'s own
 * `events` prop, oldest first, matching `EventsTimeline`'s own reading of the same list) — with
 * `live`, the feed's own history for this card (`useCardToolLog`, newest first), so a page opened
 * mid-run isn't empty (AC6) and a page left open keeps growing as new tool calls arrive.
 *
 * The one live event a fresh subscriber's connect snapshot can replay (`openCardFeedStream`'s
 * `feed.snapshot()`) may be the very event `seedEvents`' own tail already ends on — there is no
 * shared id to dedupe by (`FeedToolEvent.id` is the feed's own sequence number, never the database
 * row id `seedEvents` carries — see `feed.ts`'s own doc comment on `FeedToolEvent`), so this drops a
 * live entry that matches the seed's newest type at the same instant rather than showing the same
 * tool call twice. The instant is compared in milliseconds: the seed's `createdAt` arrives as a
 * revived `DateTime`, the feed's `ts` as an ISO string, and the two need not share an offset.
 */
const mergeRows = (seedEvents: CardEvent[], live: FeedToolEvent[]): ActivityRow[] => {
    const seedTail = seedEvents.filter(event => event.type.startsWith('tool.'));
    const newestSeed = seedTail[seedTail.length - 1];
    const dedupedLive = live.filter(
        event => !(newestSeed && Date.parse(event.ts) === newestSeed.createdAt.toMillis() && event.type === newestSeed.type),
    );

    const liveRows = dedupedLive.map(event => toRow(`live-${event.id}`, event.type, event.payload, event.ts));
    const seedRows = [...seedTail].reverse().map(event => toRow(event.id, event.type, event.payload, event.createdAt.toISO()!));

    return [...liveRows, ...seedRows].slice(0, MAX_LIVE_TOOL_EVENTS);
};

/**
 * Card 0274. A running card's tool calls as they arrive — the live counterpart to `EventsTimeline`
 * below it on the same page, which only ever shows what the last fetch happened to catch. Newest
 * first, bounded to `MAX_LIVE_TOOL_EVENTS`, each row naming the tool, `eventLabel`'s short label, and
 * a relative time off the shared `useActivityNow` clock (`lib/feed.ts`) — the same clock a board
 * tile's own "last event" line reads, so this re-renders on the same ten-second beat with no refetch.
 */
export function LiveActivity({ cardId, seedEvents }: { cardId: string; seedEvents: CardEvent[] | undefined }) {
    const live = useCardToolLog(cardId);
    const now = useActivityNow();
    const rows = useMemo(() => mergeRows(seedEvents ?? [], live), [seedEvents, live]);

    if (rows.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No tool calls yet.
            </Text>
        );
    }

    return (
        <Stack gap="xs">
            <ScrollArea h={LIST_HEIGHT} type="auto">
                <Stack gap={6}>
                    {rows.map(row => (
                        <Paper key={row.key} withBorder p="xs" radius="sm">
                            <Group gap={6} wrap="nowrap" justify="space-between" align="baseline">
                                <Badge size="xs" color="gray" variant="light">
                                    {row.tool}
                                </Badge>
                                <Text size="xs" c="dimmed">
                                    {lastEventAge(row.ts, now)}
                                </Text>
                            </Group>
                            {row.label && (
                                <Text size="xs" ff="monospace" style={{ wordBreak: 'break-word' }}>
                                    {row.label}
                                </Text>
                            )}
                        </Paper>
                    ))}
                </Stack>
            </ScrollArea>
            {rows.length >= MAX_LIVE_TOOL_EVENTS && (
                <Text size="xs" c="dimmed">
                    Showing the most recent {MAX_LIVE_TOOL_EVENTS} tool calls — more may exist.
                </Text>
            )}
        </Stack>
    );
}
