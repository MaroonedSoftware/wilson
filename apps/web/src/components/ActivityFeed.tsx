import { Box, Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { ActivityEvent } from '@wilson/sdk';
import { activityReason, summarizeActivity } from '#src/lib/activity.js';
import { lastEventAge } from '#src/lib/board.js';
import { useActivityNow } from '#src/lib/feed.js';
import { AnchorLink } from '#src/lib/router-link.js';

interface ActivityFeedProps {
    project: string;
    events: ActivityEvent[];
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
}

/** One project's events, newest first, each linking to the card it happened to. */
export function ActivityFeed({ project, events, hasMore, loadingMore, onLoadMore }: ActivityFeedProps) {
    const now = useActivityNow();

    if (events.length === 0) {
        return (
            <Text c="dimmed" size="sm">
                Nothing has happened in this project yet.
            </Text>
        );
    }

    return (
        <Stack gap="xs">
            <Paper withBorder radius="sm">
                {events.map(event => {
                    const { label, color } = summarizeActivity(event.type, event.stage, event.payload);
                    const reason = activityReason(event.payload);
                    return (
                        <Group key={event.id} gap="sm" wrap="nowrap" align="flex-start" px="sm" py={6}>
                            <Box w={8} h={8} mt={6} bg={`${color}.6`} style={{ borderRadius: '50%', flexShrink: 0 }} />
                            <Box miw={0} style={{ flex: 1 }}>
                                <Text size="sm">
                                    {label}{' '}
                                    <Text span c="dimmed">
                                        on
                                    </Text>{' '}
                                    <AnchorLink to="/projects/$project/cards/$cardId" params={{ project, cardId: event.cardId }} size="sm">
                                        {event.cardTitle ?? event.cardId}
                                    </AnchorLink>
                                </Text>
                                {reason && (
                                    <Text size="xs" c="dimmed" lineClamp={2}>
                                        {reason}
                                    </Text>
                                )}
                            </Box>
                            <Text size="xs" c="dimmed" title={event.createdAt.toLocaleString()} style={{ whiteSpace: 'nowrap' }}>
                                {lastEventAge(event.createdAt.toISO()!, now)}
                            </Text>
                        </Group>
                    );
                })}
            </Paper>
            {hasMore && (
                <Button variant="subtle" size="xs" loading={loadingMore} onClick={onLoadMore}>
                    Show older
                </Button>
            )}
        </Stack>
    );
}
