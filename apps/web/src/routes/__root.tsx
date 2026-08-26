import { Link, Outlet, createRootRoute } from '@tanstack/react-router';
import { ActionIcon, AppShell, Badge, Group, Title, Tooltip } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import { FlaggedIndicator } from '#src/components/FlaggedIndicator.js';
import { useCardFeed } from '#src/lib/feed.js';

/**
 * The shell every route renders inside. Deliberately bare: the board is card 0035 and card detail
 * is card 0036, and a shell that guesses at their layout is a shell they have to undo.
 *
 * The feed subscription lives here, one level above every route, because the header is where its
 * connection status shows and `Outlet`'s routes come and go under it. It stays open for as long as
 * the app does — there's nowhere higher to unmount from.
 */
function Root() {
    const feedStatus = useCardFeed();

    return (
        <AppShell header={{ height: 48 }} padding="md">
            <AppShell.Header>
                <Group h="100%" px="md" justify="space-between">
                    <Title order={4}>wilson</Title>
                    <Group gap="xs">
                        <FlaggedIndicator />
                        <Tooltip label={feedStatus === 'live' ? 'Updates as cards move' : 'Not connected — use refresh'}>
                            <Badge color={feedStatus === 'live' ? 'green' : 'gray'} variant="light" size="sm">
                                {feedStatus === 'live' ? 'live' : 'snapshot'}
                            </Badge>
                        </Tooltip>
                        <Tooltip label="Settings">
                            <ActionIcon component={Link} to="/settings" variant="subtle" aria-label="Settings">
                                <IconSettings size={18} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                </Group>
            </AppShell.Header>
            <AppShell.Main>
                <Outlet />
            </AppShell.Main>
        </AppShell>
    );
}

export const Route = createRootRoute({ component: Root });
