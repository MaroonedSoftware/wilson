import { Link, Outlet, createRootRoute, useParams } from '@tanstack/react-router';
import { ActionIcon, AppShell, Badge, Group, Title, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { IconLogout, IconMoon, IconRefresh, IconSettings, IconSun } from '@tabler/icons-react';
import { AuthGate } from '#src/components/AuthGate.js';
import { WilsonMark } from '#src/components/brand/WilsonMark.js';
import { FlaggedIndicator } from '#src/components/FlaggedIndicator.js';
import { ProjectSwitcher } from '#src/components/ProjectSwitcher.js';
import { StepUpDialog } from '#src/components/StepUpDialog.js';
import { CardActivityContext, useCardFeed } from '#src/lib/feed.js';
import { signOut } from '#src/lib/auth.js';
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
 * Card 0169: the `wilson` title links to `/`, the app's only home affordance before this card. `/`
 * is parameterless, so this doesn't need `AnchorLink`'s typed-params fix — but unlike `Settings`'s
 * `ActionIcon`, Mantine's `Title` doesn't merge a `component`'s own props into its polymorphic type
 * (`component?: any`, no `to`), so `component={Link}` doesn't typecheck here. Wraps a plain `Link`
 * around the `Title` instead, the same shape `FlaggedIndicator` already uses to link its badge.
 *
 * Card 0156: wraps everything below in `WilsonSdkProvider` with the unscoped `wilson` singleton — the
 * default every top-level route's components read through `useWilsonSdk()`. `FlaggedIndicator` sits
 * in the header, above `Outlet`, so it always sees this default regardless of which route matched
 * below, exactly as it did before this card. A `/projects/$project/*` route nests its own provider
 * around its own subtree, overriding this default with `wilsonForProject` for whatever it renders.
 *
 * Card 0154: `useCardFeed(project)` above is this card's other change — the feed connects naming
 * whichever project the matched route carries, so an event in another registered project no longer
 * invalidates or refetches this one's board (see `feed.ts`'s own doc comment). `ProjectSwitcher` sits
 * beside `FlaggedIndicator` for the same reason that badge does — it belongs above `Outlet`, reachable
 * from every screen, not folded into any one route. It renders nothing of its own when fewer than two
 * projects are registered, so a single-project deployment's header looks exactly as it did before
 * this card.
 *
 * Card 0172: replaces what card 0169's home `Link` wraps — a bare `Title` — with `WilsonMark` beside
 * the same `Title`, and adds the color-scheme toggle (`ColorSchemeToggle` below). The `Link to="/"`
 * itself is untouched (this card's Constraints: it's the app's only way home, and dropping it would
 * regress silently since nothing else asserts it — `dashboard.test.ts`'s "the header title" tests
 * already cover it and keep passing unchanged, because `title.closest('a')` still resolves to this
 * same `Link`).
 *
 * Card 0173: the snapshot badge used to sit behind a tooltip reading "Not connected — use refresh"
 * with nothing here that actually did that — the only way to reconnect was a full page reload. An
 * `ActionIcon` beside the badge calls `feed.reconnect()` (`lib/feed.ts`) instead, which invalidates
 * every query and tears down and reopens the `EventSource`; the tooltip now names the control next to
 * it rather than describing an action this screen couldn't take.
 *
 * Card 0274: `feed.activity`/`feed.toolLog`/`feed.now` are provided through `CardActivityContext`
 * around everything below the header, the same "one subscription, read from wherever" shape this
 * component already gives the feed's `status`/`reconnect` — a board tile (`Board.tsx`) and a card
 * page's live tool list (`LiveActivity.tsx`) both read this instead of either opening its own
 * `EventSource`.
 */
function Root() {
    return (
        <AuthGate>
            <Shell />
        </AuthGate>
    );
}

/**
 * Everything a signed-in operator sees. Rendered only under `AuthGate`, so the feed subscription
 * below opens once there is a session for it to authenticate with.
 */
function Shell() {
    const { project } = useParams({ strict: false });
    const feed = useCardFeed(project);

    return (
        <WilsonSdkProvider client={wilson}>
            <CardActivityContext.Provider value={{ activity: feed.activity, toolLog: feed.toolLog, now: feed.now }}>
                <AppShell header={{ height: 48 }} padding="md">
                    <Notifications />
                    <StepUpDialog />
                    <AppShell.Header>
                        <Group h="100%" px="md" justify="space-between">
                            <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
                                <Group gap={8} wrap="nowrap">
                                    <WilsonMark size={24} />
                                    <Title order={4}>wilson</Title>
                                </Group>
                            </Link>
                            <Group gap="xs">
                                <FlaggedIndicator />
                                <ProjectSwitcher />
                                <Tooltip label={feed.status === 'live' ? 'Updates as cards move' : 'Not connected — see refresh'}>
                                    <Badge color={feed.status === 'live' ? 'green' : 'gray'} variant="light" size="sm">
                                        {feed.status === 'live' ? 'live' : 'snapshot'}
                                    </Badge>
                                </Tooltip>
                                <Tooltip label="Refresh">
                                    <ActionIcon onClick={feed.reconnect} variant="subtle" aria-label="Refresh">
                                        <IconRefresh size={18} />
                                    </ActionIcon>
                                </Tooltip>
                                <ColorSchemeToggle />
                                <Tooltip label="Settings">
                                    <ActionIcon component={Link} to="/settings" variant="subtle" aria-label="Settings">
                                        <IconSettings size={18} />
                                    </ActionIcon>
                                </Tooltip>
                                <Tooltip label="Sign out">
                                    <ActionIcon onClick={() => void signOut()} variant="subtle" aria-label="Sign out">
                                        <IconLogout size={18} />
                                    </ActionIcon>
                                </Tooltip>
                            </Group>
                        </Group>
                    </AppShell.Header>
                    <AppShell.Main>
                        <Outlet />
                    </AppShell.Main>
                </AppShell>
            </CardActivityContext.Provider>
        </WilsonSdkProvider>
    );
}

/**
 * Flips between light and dark (card 0172's Constraints: `defaultColorScheme="auto"` with a
 * persisted toggle). `toggleColorScheme` already resolves `"auto"` against the OS preference before
 * deciding which way to flip (`useMantineColorScheme`'s own implementation), so this never needs to
 * read `"auto"` itself — only `useComputedColorScheme` for which icon to show right now.
 */
function ColorSchemeToggle() {
    const { toggleColorScheme } = useMantineColorScheme();
    const computedColorScheme = useComputedColorScheme('light');

    return (
        <Tooltip label="Toggle color scheme">
            <ActionIcon onClick={toggleColorScheme} variant="subtle" aria-label="Toggle color scheme">
                {computedColorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
        </Tooltip>
    );
}

export const Route = createRootRoute({ component: Root });
