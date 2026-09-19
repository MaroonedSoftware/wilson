import { Badge, Button, Code, Divider, Grid, Group, List, Loader, Paper, Select, Stack, Tabs, Text, Timeline, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardColumns, CardDetail, CardEvent, CardVersion, ContextSnapshot } from '@wilson/sdk';
import { TONE } from '#src/components/Board.js';
import { CardContext } from '#src/components/CardContext.js';
import { DependenciesSection, EditBodyControl, RenameControl } from '#src/components/CardEditControls.js';
import { CriteriaPanel } from '#src/components/CriteriaPanel.js';
import { DraftPane } from '#src/components/DraftPane.js';
import { Markdown } from '#src/components/Markdown.js';
import { PlanningSessionPane } from '#src/components/PlanningSession.js';
import { acceptanceCriteria, filesInScope, formatTimestamp } from '#src/lib/card.js';
import { invalidateCard, invalidateCardsList, reasonFor, useAckCard, useMoveCard, useReleaseCard, useStartCard } from '#src/lib/mutations.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

/** Below this width the two `planning` panes stack into `Tabs` instead of sitting side by side. */
const NARROW_BREAKPOINT = '(max-width: 62em)';

/** A fixed height for both `planning` panes — otherwise a `ScrollArea` inside a `Stack` has nothing
 * to bound its own growth against and never actually scrolls. */
const PANE_HEIGHT = 520;

/**
 * Card 0137: a card in `planning` — and, since card 0159, `parking-lot` — gets a two-pane session:
 * the conversation (`PlanningSessionPane`) beside the session's live draft (`DraftPane`, card
 * [[0138]]). `Tabs` when the viewport is too narrow for both side by side, `Grid` otherwise; either
 * way the same two panes, never a third layout that could drift from what each renders alone.
 */
function PlanningPanes({ card, project }: { card: CardDetail; project?: string }) {
    const narrow = useMediaQuery(NARROW_BREAKPOINT);

    const conversation = (
        <Stack gap={6} h={PANE_HEIGHT}>
            <Title order={5}>Conversation</Title>
            <PlanningSessionPane card={card} project={project} />
        </Stack>
    );
    const draft = (
        <Stack gap={6} h={PANE_HEIGHT}>
            <Title order={5}>Plan</Title>
            <DraftPane card={card} />
        </Stack>
    );

    if (narrow) {
        return (
            <Tabs defaultValue="conversation">
                <Tabs.List>
                    <Tabs.Tab value="conversation">Conversation</Tabs.Tab>
                    <Tabs.Tab value="plan">Plan</Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="conversation" pt="sm">
                    {conversation}
                </Tabs.Panel>
                <Tabs.Panel value="plan" pt="sm">
                    {draft}
                </Tabs.Panel>
            </Tabs>
        );
    }

    return (
        <Grid>
            <Grid.Col span={6}>{conversation}</Grid.Col>
            <Grid.Col span={6}>{draft}</Grid.Col>
        </Grid>
    );
}

function StageBadge({ stage }: { stage: string }) {
    return (
        <Badge color={TONE[stage] ?? 'gray'} variant="light" radius="sm">
            {stage}
        </Badge>
    );
}

/**
 * Where an operator sends the card next. Options are the board's own configured stages plus its
 * non-stages (`GET /api/stages`) — never a hard-coded list, since stages are config (card 0037's
 * plan). The value always reads from `card.stage`, never from what was picked: this is a request,
 * not a transition rendered ahead of it (PROJECT.md, Architecture) — the runner is sole writer and
 * may refuse it, so the select only moves once the query that fed it has actually re-fetched.
 */
function MoveControl({ card, columns, columnsError }: { card: CardDetail; columns: BoardColumns | undefined; columnsError: Error | null | undefined }) {
    const moveCard = useMoveCard(card.id);

    if (columnsError) {
        return (
            <Text size="sm" c="red">
                Could not load stages: {columnsError.message}
            </Text>
        );
    }
    if (!columns) return <Loader size="xs" />;

    const targets = [...columns.stages, ...columns.nonStages];

    return (
        <Select
            aria-label="Move to stage"
            data={targets}
            value={card.stage}
            onChange={stage => {
                if (stage && stage !== card.stage) moveCard.mutate(stage);
            }}
            disabled={moveCard.isPending}
            allowDeselect={false}
            w={200}
        />
    );
}

/**
 * Enqueues the card for its stage (`POST .../start`) — the same two refusals `wilson card start`
 * makes, not re-implemented here: `whyNotDispatchable`, and a card a job is already carrying. Either
 * arrives as a notification (`useStartCard`), not inline, since there is nowhere on a button to put
 * a sentence.
 */
function EnqueueButton({ card }: { card: CardDetail }) {
    const startCard = useStartCard(card.id);

    return (
        <Button size="xs" variant="light" onClick={() => startCard.mutate()} loading={startCard.isPending}>
            Enqueue
        </Button>
    );
}

/**
 * Card 0143. `POST .../merge`, from `CardDetail.tsx` rather than `lib/mutations.ts` — that file is
 * outside this card's "Files in scope", and this hook's shape otherwise matches `useStartCard`
 * above it exactly: same invalidation, same "surface a refusal as a notification" rule.
 *
 * A genuine refusal (this card is not in `ready` — `onError` below) is not the only outcome worth
 * telling an operator about. `MergeResult.merged: false` is a normal 200 — a conflict or a failed
 * suite, the two honest ways an attempt can not land — and it arrives in `onSuccess`, so both paths
 * end up as a notification either way; there is nowhere on a button to put a sentence, the same
 * reasoning `EnqueueButton` below already relies on.
 *
 * Card 0156: reads its client through `useWilsonSdk()` instead of importing the singleton directly,
 * so a card reached through a `/projects/$project/*` route merges against that project's client.
 *
 * Card 0155: invalidates through `invalidateCardsList`/`invalidateCard` (`lib/mutations.js`) rather
 * than the literal `['cards']`/`['card', id]` keys this hook copied from `useStartCard` — those keys
 * stopped matching anything the moment a card's own page moved to `/projects/$project/cards/$cardId`
 * and started keying its query `['project', project, 'card', id]` instead.
 */
function useMergeCard(id: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => wilson.board.mergeCard(id),
        onSuccess: result => {
            invalidateCardsList(queryClient);
            invalidateCard(queryClient, id);
            if (result.merged) {
                notifications.show({ color: 'green', title: 'Merged', message: `Landed on main as ${result.commit?.slice(0, 8) ?? result.commit}` });
            } else {
                notifications.show({ color: 'red', title: 'Could not merge the card', message: result.reason ?? 'unknown reason' });
            }
        },
        onError: err => {
            notifications.show({ color: 'red', title: 'Could not merge the card', message: reasonFor(err) });
        },
    });
}

/**
 * Card 0143's operator-facing end: the merge the board used to require a shell for, behind one
 * button. Only rendered for a card in `ready` — the one stage this operation ever acts on
 * (`BoardWriteService.merge` refuses every other one) — so there is nothing to disable, only
 * something to hide.
 */
function MergeControl({ card }: { card: CardDetail }) {
    const mergeCard = useMergeCard(card.id);

    if (card.stage !== 'ready') return null;

    return (
        <Button size="xs" variant="light" color="green" onClick={() => mergeCard.mutate()} loading={mergeCard.isPending}>
            Merge
        </Button>
    );
}

/**
 * Card 0087's other safe-cancel operator action, beside `EnqueueButton`/`MergeControl` in the
 * action row. Renders unconditionally, the same reasoning `EnqueueButton` above already relies on
 * (this card's Constraints): there is no client-side signal for "a job carries this card" to hide
 * behind, so a card nothing is carrying just gets the server's own refusal as a notification
 * (`useReleaseCard`, `lib/mutations.ts`) rather than a control this file guessed should be hidden.
 */
function ReleaseControl({ card }: { card: CardDetail }) {
    const releaseCard = useReleaseCard(card.id);

    return (
        <Button size="xs" variant="light" color="orange" onClick={() => releaseCard.mutate()} loading={releaseCard.isPending}>
            Release
        </Button>
    );
}

/**
 * The needs-human panel's own way to clear the flag (card 0087's `POST .../ack`), replacing the
 * `wilson card ack {id}` hint that used to point an operator at a terminal for this. No optimistic
 * clearing (this card's Constraints): the panel above keeps rendering until the refetched card
 * actually says `needsHuman: false` (`useAckCard`'s invalidation), the same rule `MoveControl`
 * follows for a stage change.
 */
function AckButton({ card }: { card: CardDetail }) {
    const ackCard = useAckCard(card.id);

    return (
        <Button size="xs" variant="light" color="red" onClick={() => ackCard.mutate()} loading={ackCard.isPending}>
            Acknowledge
        </Button>
    );
}

/**
 * Card 0104's `dispatch.deferred` event carries why in its payload (`recordDeferral`,
 * jobs/dispatch.deferred.ts: `{ outstanding?: string[]; reason: string }`) — until now the only place
 * that reason was visible was the server log, so an operator reading the web timeline saw a bare
 * event type with no way to tell a scope conflict from any other deferral. `payload` arrives typed as
 * generic JSON (there is no per-`type` payload union on the wire), so this reads `reason` back out by
 * hand rather than trusting a type that does not exist; anything that is not a string is treated as
 * "nothing to show" rather than rendered as `[object Object]` or similar.
 */
function deferredReason(payload: unknown): string | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const reason = (payload as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
}

/**
 * The timeline an operator reads to answer "why is this card not moving" — newest event first,
 * each tagged with the stage it happened in, favouring legibility over density.
 */
function EventsTimeline({ events, limit, error }: { events: CardEvent[] | undefined; limit: number; error: Error | null | undefined }) {
    if (error) {
        return (
            <Text size="sm" c="red">
                Could not load events: {error.message}
            </Text>
        );
    }
    if (!events) return <Loader size="xs" />;
    if (events.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No events yet.
            </Text>
        );
    }

    // The API returns its tail oldest-first; this view reads newest-first, which is where an
    // operator chasing a stuck card starts looking.
    const newestFirst = [...events].reverse();

    return (
        <Stack gap="xs">
            <Timeline active={newestFirst.length} bulletSize={14} lineWidth={2}>
                {newestFirst.map(event => {
                    const reason = event.type === 'dispatch.deferred' ? deferredReason(event.payload) : undefined;
                    return (
                        <Timeline.Item key={event.id} title={event.type}>
                            <Group gap={6}>
                                {event.stage && (
                                    <Badge size="xs" color={TONE[event.stage] ?? 'gray'} variant="light">
                                        {event.stage}
                                    </Badge>
                                )}
                                <Text size="xs" c="dimmed">
                                    {formatTimestamp(event.createdAt)}
                                </Text>
                            </Group>
                            {reason && (
                                <Text size="xs" c="dimmed">
                                    {reason}
                                </Text>
                            )}
                        </Timeline.Item>
                    );
                })}
            </Timeline>
            {events.length >= limit && (
                <Text size="xs" c="dimmed">
                    Showing the most recent {limit} events — more may exist.
                </Text>
            )}
        </Stack>
    );
}

/** The card's history from `card_versions` — the message that used to be a git commit message, and when. */
function VersionsList({ versions, limit, error }: { versions: CardVersion[] | undefined; limit: number; error: Error | null | undefined }) {
    if (error) {
        return (
            <Text size="sm" c="red">
                Could not load versions: {error.message}
            </Text>
        );
    }
    if (!versions) return <Loader size="xs" />;
    if (versions.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No versions yet.
            </Text>
        );
    }

    return (
        <Stack gap="xs">
            {versions.map(version => (
                <Paper key={version.id} withBorder p="xs" radius="sm">
                    <Text size="sm">{version.message}</Text>
                    <Text size="xs" c="dimmed">
                        {formatTimestamp(version.createdAt)}
                    </Text>
                </Paper>
            ))}
            {versions.length >= limit && (
                <Text size="xs" c="dimmed">
                    Showing the most recent {limit} versions — more may exist.
                </Text>
            )}
        </Stack>
    );
}

/**
 * A card, in full: what it is (title, stage, branch, plan) and what has happened to it (events,
 * versions) — plus, since card 0037, its two operator actions: move it to another stage, and
 * enqueue it for the one it's in. The plan itself stays read-only, matching the card 0036 contract —
 * no editing the plan, no approving it, no cancelling a running job — except in `planning` and, since
 * card 0159, `parking-lot` (card 0137, [[0138]]), where an operator can hold the planning
 * conversation from here, hand-edit the live draft it produces, and approve it as a new version, all
 * without a terminal.
 */
export function CardDetailView({
    card,
    events,
    eventsLimit,
    eventsError,
    versions,
    versionsLimit,
    versionsError,
    context,
    contextError,
    columns,
    columnsError,
    project,
}: {
    card: CardDetail;
    events: CardEvent[] | undefined;
    eventsLimit: number;
    eventsError: Error | null | undefined;
    versions: CardVersion[] | undefined;
    versionsLimit: number;
    versionsError: Error | null | undefined;
    /** Card 0189: the card's attached context snapshots, from the query `ProjectCardDetailRoute`
     * mounts alongside `events`/`versions`. */
    context: ContextSnapshot[] | undefined;
    contextError: Error | null | undefined;
    columns: BoardColumns | undefined;
    columnsError: Error | null | undefined;
    /** Card 0153: the project this card was reached under, threaded to `PlanningPanes` so the
     * planning stream (`usePlanTranscript`) names it. Card 0155: required rather than optional now
     * that `ProjectCardDetailRoute` is this view's only caller — the top-level `/cards/$cardId` route
     * that used to leave this `undefined` is gone. */
    project: string;
}) {
    const scope = filesInScope(card.sections['files-in-scope']);
    const criteria = acceptanceCriteria(card.sections['acceptance-criteria']);

    return (
        <Stack gap="lg">
            <Stack gap={4}>
                <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                    ← Back to the board
                </AnchorLink>
                <Group gap="sm" align="baseline">
                    <Text size="sm" c="dimmed" ff="monospace">
                        {card.id}
                    </Text>
                    <Title order={2}>{card.title}</Title>
                    <RenameControl card={card} />
                </Group>
                <Group gap="xs">
                    <StageBadge stage={card.stage} />
                    {card.needsHuman && (
                        <Badge color="red" variant="light" radius="sm">
                            needs human
                        </Badge>
                    )}
                    {card.branch && (
                        <Badge color="gray" variant="outline" radius="sm" ff="monospace">
                            {card.branch}
                        </Badge>
                    )}
                </Group>
                <Group gap="xs" align="center">
                    <MoveControl card={card} columns={columns} columnsError={columnsError} />
                    <EnqueueButton card={card} />
                    <ReleaseControl card={card} />
                    <MergeControl card={card} />
                </Group>
            </Stack>

            {card.needsHuman && (
                <Paper withBorder p="sm" radius="sm" style={{ borderColor: 'var(--mantine-color-red-6)' }}>
                    <Stack gap={6}>
                        <Text size="sm" fw={500} c="red">
                            {card.needsHumanReason ?? 'This card is flagged for a human.'}
                        </Text>
                        <AckButton card={card} />
                    </Stack>
                </Paper>
            )}

            {scope.length > 0 && (
                <Stack gap={6}>
                    <Title order={4}>Files in scope</Title>
                    <List size="sm" spacing={4}>
                        {scope.map(pattern => (
                            <List.Item key={pattern}>
                                <Code>{pattern}</Code>
                            </List.Item>
                        ))}
                    </List>
                </Stack>
            )}

            {criteria.length > 0 && <CriteriaPanel criteria={criteria} events={events} />}

            {card.stage === 'planning' || card.stage === 'parking-lot' ? (
                <PlanningPanes card={card} project={project} />
            ) : (
                <Stack gap={6}>
                    <Group justify="space-between" align="center">
                        <Title order={4}>Plan</Title>
                        <EditBodyControl card={card} />
                    </Group>
                    <Markdown body={card.body} />
                </Stack>
            )}

            <Divider />

            <CardContext cardId={card.id} snapshots={context} error={contextError} />

            <Divider />

            <Stack gap={6}>
                <Title order={4}>Dependencies</Title>
                <DependenciesSection card={card} />
            </Stack>

            <Divider />

            <Stack gap={6}>
                <Title order={4}>Events</Title>
                <EventsTimeline events={events} limit={eventsLimit} error={eventsError} />
            </Stack>

            <Divider />

            <Stack gap={6}>
                <Title order={4}>Versions</Title>
                <VersionsList versions={versions} limit={versionsLimit} error={versionsError} />
            </Stack>
        </Stack>
    );
}
