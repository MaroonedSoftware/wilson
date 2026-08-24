import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Alert, Group, Loader, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { Board, BoardTitle } from '#src/components/Board.js';
import { wilson } from '#src/lib/sdk.js';

/**
 * The board.
 *
 * Refresh is a button, not a poll and not a subscription. The feed exists (card 0034) and the board
 * will subscribe to it, but until it does, a refetch the operator asked for beats an interval
 * nobody chose.
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
                <Tooltip label="Refresh">
                    <ActionIcon variant="subtle" onClick={refresh} loading={cards.isFetching || columns.isFetching} aria-label="Refresh the board">
                        <IconRefresh size={16} />
                    </ActionIcon>
                </Tooltip>
            </Group>
            <Board columns={columns.data} cards={cards.data} />
        </>
    );
}

export const Route = createFileRoute('/')({ component: Index });
