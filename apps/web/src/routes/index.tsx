import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Loader, Text } from '@mantine/core';
import { wilson } from '#src/lib/sdk.js';

/**
 * The walking skeleton for the web app: one query through the generated client, rendered.
 *
 * It exists to prove the chain end to end — codegen, the SDK, CORS, TanStack Query — before any
 * card depends on it. Card 0035 replaces this with the board.
 */
function Index() {
    const cards = useQuery({ queryKey: ['cards'], queryFn: () => wilson.board.listCards() });

    if (cards.isPending) return <Loader size="sm" />;
    if (cards.isError)
        return (
            <Alert color="red" title="Cannot reach the API">
                {cards.error.message}
            </Alert>
        );

    return <Text>{cards.data.length} cards on the board.</Text>;
}

export const Route = createFileRoute('/')({ component: Index });
