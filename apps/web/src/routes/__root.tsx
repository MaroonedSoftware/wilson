import { Link, Outlet, createRootRoute, useParams } from '@tanstack/react-router';
import { ActionIcon, AppShell, Badge, Group, Title, Tooltip } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { IconSettings } from '@tabler/icons-react';
import { FlaggedIndicator } from '#src/components/FlaggedIndicator.js';
import { useCardFeed } from '#src/lib/feed.js';
import { wilson } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';

/**
 * The shell every route renders inside. Deliberately bare: the board is card 0035 and card detail
 * is card 0036, and a shell that guesses at their layout is a shell they have to undo.
 *
 * The feed subscription lives here, one level above every route, because the header is where its
 * connection status shows and `Outlet`'s routes come and go under it. It stays open for as long as
 * the app does — there's nowhere higher to unmount from.
 *
 * `Notifications` is mounted here too, once, for the same reason — every route below it (a move or
 * an enqueue refused from the card detail view, card 0037) needs somewhere to render a toast, and
 * this is the one place above all of them.
 *
 * Card 0153: `useParams({ strict: false })` reads whichever route actually matched, below this one —
 * a top-level route carries no `project` param at all, so `project` is `undefined` there, same as
 * before this card; a `/projects/$project/*` route carries its own, and the feed connects naming it.
 *
 * Card 0156: wraps everything below in `WilsonSdkProvider` with the unscoped `wilson` singleton — the
 * default every top-level route's components read through `useWilsonSdk()`. `FlaggedIndicator` sits
 * in the header, above `Outlet`, so it always sees this default regardless of which route matched
 * below, exactly as it did before this card. A `/projects/$project/*` route nests its own provider
 * around its own subtree, overriding this default with `wilsonForProject` for whatever it renders.
 */
function Root() {
    const { project } = useParams({ strict: false });
    const feedStatus = useCardFeed(project);

    return (
        <WilsonSdkProvider client={wilson}>
            <AppShell header={{ height: 48 }} padding="md">
                <Notifications />
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
        </WilsonSdkProvider>
    );
}

export const Route = createRootRoute({ component: Root });
