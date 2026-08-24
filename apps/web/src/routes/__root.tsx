import { Outlet, createRootRoute } from '@tanstack/react-router';
import { AppShell, Group, Title } from '@mantine/core';

/**
 * The shell every route renders inside. Deliberately bare: the board is card 0035 and card detail
 * is card 0036, and a shell that guesses at their layout is a shell they have to undo.
 */
export const Route = createRootRoute({
    component: () => (
        <AppShell header={{ height: 48 }} padding="md">
            <AppShell.Header>
                <Group h="100%" px="md">
                    <Title order={4}>wilson</Title>
                </Group>
            </AppShell.Header>
            <AppShell.Main>
                <Outlet />
            </AppShell.Main>
        </AppShell>
    ),
});
