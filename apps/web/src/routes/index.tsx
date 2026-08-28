import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Alert, Group, Loader, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { Board, BoardTitle } from '#src/components/Board.js';
import { NewCardControl } from '#src/components/NewCardControl.js';
import { wilson } from '#src/lib/sdk.js';

/**
 * The board.
 *
 * The feed (card 0034, wired up in `#src/lib/feed.js`) keeps the cards query fresh on its own, so
 * the refresh button exists for when the feed is down or an operator wants a refetch right now — a
 * manual fallback, not the only way the board updates.
 *
 * `NewCardControl` (card 0142) sits in the same toolbar — filing a card is the one board action an
 * operator reaches for as often as looking at the board itself, so it belongs beside the title, not
 * behind a menu.
 */
function Index() {
    const columns = useQuery({ queryKey: ['columns'], queryFn: () => wilson.board.listBoardColumns() });
    const cards = useQuery({ queryKey: ['cards'], queryFn: () => wilson.board.listCards() });

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
        <>
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
        </>
    );
}

export const Route = createFileRoute('/')({ component: Index });
