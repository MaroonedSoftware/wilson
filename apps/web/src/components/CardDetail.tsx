import { Anchor, Badge, Code, Divider, Group, List, Loader, Paper, Stack, Text, Timeline, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { CardDetail, CardEvent, CardVersion } from '@wilson/sdk';
import { TONE } from '#src/components/Board.js';
import { Markdown } from '#src/components/Markdown.js';
import { filesInScope, formatTimestamp } from '#src/lib/card.js';

function StageBadge({ stage }: { stage: string }) {
    return (
        <Badge color={TONE[stage] ?? 'gray'} variant="light" radius="sm">
            {stage}
        </Badge>
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
 * versions). Read-only, matching the card 0036 contract — no editing the plan, no moving the card.
 */
export function CardDetailView({
    card,
    events,
    eventsLimit,
    eventsError,
    versions,
    versionsLimit,
    versionsError,
}: {
    card: CardDetail;
    events: CardEvent[] | undefined;
    eventsLimit: number;
    eventsError: Error | null | undefined;
    versions: CardVersion[] | undefined;
    versionsLimit: number;
    versionsError: Error | null | undefined;
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

            <Stack gap={6}>
                <Title order={4}>Plan</Title>
                <Markdown body={card.body} />
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
