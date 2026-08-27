import { Anchor, Badge, Button, Code, Divider, Grid, Group, List, Loader, Paper, ScrollArea, Select, Stack, Tabs, Text, Timeline, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from '@tanstack/react-router';
import type { BoardColumns, CardDetail, CardEvent, CardVersion } from '@wilson/sdk';
import { TONE } from '#src/components/Board.js';
import { Markdown } from '#src/components/Markdown.js';
import { PlanningSessionPane } from '#src/components/PlanningSession.js';
import { filesInScope, formatTimestamp } from '#src/lib/card.js';
import { useMoveCard, useStartCard } from '#src/lib/mutations.js';

/** Below this width the two `planning` panes stack into `Tabs` instead of sitting side by side. */
const NARROW_BREAKPOINT = '(max-width: 62em)';

/** A fixed height for both `planning` panes — otherwise a `ScrollArea` inside a `Stack` has nothing
 * to bound its own growth against and never actually scrolls. */
const PANE_HEIGHT = 520;

/**
 * Card 0137: a card in `planning` gets a two-pane session — the conversation
 * (`PlanningSessionPane`) beside the card's current body, read-only, standing in for the draft pane
 * [[0138]] builds. `Tabs` when the viewport is too narrow for both side by side, `Grid` otherwise;
 * either way the same two panes, never a third layout that could drift from what each renders alone.
 */
function PlanningPanes({ card }: { card: CardDetail }) {
    const narrow = useMediaQuery(NARROW_BREAKPOINT);

    const conversation = (
        <Stack gap={6} h={PANE_HEIGHT}>
            <Title order={5}>Conversation</Title>
            <PlanningSessionPane card={card} />
        </Stack>
    );
    const draft = (
        <Stack gap={6}>
            <Title order={5}>Plan</Title>
            <ScrollArea h={PANE_HEIGHT} type="auto">
                <Markdown body={card.body} />
            </ScrollArea>
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
                {newestFirst.map(event => (
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
                    </Timeline.Item>
                ))}
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
 * no editing the plan, no approving it, no cancelling a running job — except in `planning` itself
 * (card 0137), where an operator can hold the planning conversation from here instead of only from
 * a terminal; the body shown there is still the card's current one, read-only, standing in for the
 * draft pane [[0138]] builds.
 */
export function CardDetailView({
    card,
    events,
    eventsLimit,
    eventsError,
    versions,
    versionsLimit,
    versionsError,
    columns,
    columnsError,
}: {
    card: CardDetail;
    events: CardEvent[] | undefined;
    eventsLimit: number;
    eventsError: Error | null | undefined;
    versions: CardVersion[] | undefined;
    versionsLimit: number;
    versionsError: Error | null | undefined;
    columns: BoardColumns | undefined;
    columnsError: Error | null | undefined;
}) {
    const scope = filesInScope(card.sections['files-in-scope']);

    return (
        <Stack gap="lg">
            <Stack gap={4}>
                <Anchor component={Link} to="/" size="sm">
                    ← Back to the board
                </Anchor>
                <Group gap="sm" align="baseline">
                    <Text size="sm" c="dimmed" ff="monospace">
                        {card.id}
                    </Text>
                    <Title order={2}>{card.title}</Title>
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
                </Group>
            </Stack>

            {card.needsHuman && (
                <Paper withBorder p="sm" radius="sm" style={{ borderColor: 'var(--mantine-color-red-6)' }}>
                    <Stack gap={4}>
                        <Text size="sm" fw={500} c="red">
                            {card.needsHumanReason ?? 'This card is flagged for a human.'}
                        </Text>
                        <Text size="xs" c="dimmed">
                            Clear it with <Code>wilson card ack {card.id}</Code>.
                        </Text>
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

            {card.stage === 'planning' ? (
                <PlanningPanes card={card} />
            ) : (
                <Stack gap={6}>
                    <Title order={4}>Plan</Title>
                    <Markdown body={card.body} />
                </Stack>
            )}

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
