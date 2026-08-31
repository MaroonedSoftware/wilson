import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Alert, Group, Title, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { Board, BoardTitle } from '#src/components/Board.js';
import { BoardFilter } from '#src/components/BoardFilter.js';
import { BoardSkeleton } from '#src/components/BoardSkeleton.js';
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
 *
 * Card 0175: a cold load renders `BoardSkeleton` instead of a bare `Loader` in the pending branch,
 * and the toolbar gets `BoardFilter` — client-side component state, no query changes, no URL
 * persistence (this card's Constraints' explicit non-goal). `Board.tsx` is untouched: the filtered
 * array is passed as `cards`, the unfiltered `cards.data` as `allCards`, exactly the `/flagged`
 * pattern beside this file already uses for dependency resolution.
 */
function ProjectBoardRoute() {
    const { project } = Route.useParams();
    const client = useMemo(() => wilsonForProject(project), [project]);
    const [filterText, setFilterText] = useState('');

    const columns = useQuery({ queryKey: ['project', project, 'columns'], queryFn: () => client.board.listBoardColumns() });
    const cards = useQuery({ queryKey: ['project', project, 'cards'], queryFn: () => client.board.listCards() });

    // Runs on every render, including the pending one above, so the hook order stays stable —
    // `cards.data` is undefined until the query resolves, which `?? []` covers.
    const query = filterText.trim().toLowerCase();
    const filteredCards = useMemo(() => {
        const data = cards.data ?? [];
        if (!query) return data;
        return data.filter(card => card.id.toLowerCase().includes(query) || card.title.toLowerCase().includes(query));
    }, [cards.data, query]);

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
    if (!columns.data || !cards.data) return <BoardSkeleton />;

    return (
        <WilsonSdkProvider client={client}>
            <Group justify="space-between" mb="md">
                {query ? (
                    <Title order={5} fw={500}>
                        {filteredCards.length} of {cards.data.length} cards
                    </Title>
                ) : (
                    <BoardTitle count={cards.data.length} />
                )}
                <Group gap="xs">
                    <BoardFilter value={filterText} onChange={setFilterText} />
                    <NewCardControl />
                    <Tooltip label="Refresh">
                        <ActionIcon variant="subtle" onClick={refresh} loading={cards.isFetching || columns.isFetching} aria-label="Refresh the board">
                            <IconRefresh size={16} />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            </Group>
            <Board columns={columns.data} cards={filteredCards} allCards={cards.data} project={project} />
        </WilsonSdkProvider>
    );
}

export const Route = createFileRoute('/projects/$project/')({ component: ProjectBoardRoute });
