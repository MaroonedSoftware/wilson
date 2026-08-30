import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Alert, Group, Loader, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { Board, BoardTitle } from '#src/components/Board.js';
import { NewCardControl } from '#src/components/NewCardControl.js';
import { wilsonForProject } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';

/**
 * Card 0153: the board at a project-scoped URL, `/projects/$project` — the same screen `/`
 * (`index.tsx`) renders, reading through a client built for this route's own `project` param
 * (`wilsonForProject`, `lib/sdk.js`) instead of the app-wide singleton `/` still uses. Query keys are
 * prefixed with `project` so this screen's cache can never collide with `/`'s own unprefixed
 * `['cards']`/`['columns']` — two different projects, or this project and the daemon's default one,
 * must never read each other's cache entry.
 *
 * `NewCardControl` and `Board`'s own drag-to-move (`lib/mutations.ts`) still write through the
 * singleton client and still navigate/link to `/cards/$cardId` — carrying every write and every link
 * on this screen onto the project-scoped client and route is the 9-file, 14-importer propagation this
 * card's plan defers to [[0155]]. This screen reads the named project correctly; writing back to it
 * is that later card's job.
 *
 * Card 0156: wraps its render tree in `WilsonSdkProvider` with `client` so a component reading through
 * `useWilsonSdk()` gets this project's client rather than `__root.tsx`'s unscoped default.
 */
function ProjectBoardRoute() {
    const { project } = Route.useParams();
    const client = useMemo(() => wilsonForProject(project), [project]);

    const columns = useQuery({ queryKey: ['project', project, 'columns'], queryFn: () => client.board.listBoardColumns() });
    const cards = useQuery({ queryKey: ['project', project, 'cards'], queryFn: () => client.board.listCards() });

    const refresh = () => {
        void columns.refetch();
        void cards.refetch();
    };

    const error = columns.error ?? cards.error;
    if (error) {
        return (
            <Alert color="red" title="Cannot reach the API">
                {error.message}
            </Alert>
        );
    }

    // Guarding on `data` rather than `isPending` narrows both queries for the render below; a
    // single `isPending ||` check leaves TanStack Query's union unresolved on each of them.
    if (!columns.data || !cards.data) return <Loader size="sm" />;

    return (
        <WilsonSdkProvider client={client}>
            <Group justify="space-between" mb="md">
                <BoardTitle count={cards.data.length} />
                <Group gap="xs">
                    <NewCardControl />
                    <Tooltip label="Refresh">
                        <ActionIcon variant="subtle" onClick={refresh} loading={cards.isFetching || columns.isFetching} aria-label="Refresh the board">
                            <IconRefresh size={16} />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            </Group>
            <Board columns={columns.data} cards={cards.data} />
        </WilsonSdkProvider>
    );
}

export const Route = createFileRoute('/projects/$project/')({ component: ProjectBoardRoute });
