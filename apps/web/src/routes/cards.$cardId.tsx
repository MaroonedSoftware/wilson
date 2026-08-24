import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Anchor, Loader, Stack } from '@mantine/core';
import { CardDetailView } from '#src/components/CardDetail.js';
import { wilson } from '#src/lib/sdk.js';

/** `limit` passed to both history endpoints — bounds the fetch; the view flags when more may exist. */
const HISTORY_LIMIT = 50;

/**
 * A card's own page: `/cards/$cardId`, reachable and reloadable by URL.
 *
 * Three separate queries rather than one combined endpoint, matching the API's own shape
 * (`/api/cards/:id`, `/events`, `/versions`) — the plan can render as soon as it arrives without
 * waiting on the event or version history.
 */
function CardDetailRoute() {
    const { cardId } = Route.useParams();

    const card = useQuery({ queryKey: ['card', cardId], queryFn: () => wilson.board.getCard(cardId) });
    const events = useQuery({
        queryKey: ['card', cardId, 'events'],
        queryFn: () => wilson.board.listCardEvents(cardId, { limit: HISTORY_LIMIT }),
    });
    const versions = useQuery({
        queryKey: ['card', cardId, 'versions'],
        queryFn: () => wilson.board.listCardVersions(cardId, { limit: HISTORY_LIMIT }),
    });

    if (card.error) {
        return (
            <Stack gap="sm">
                <Alert color="red" title="Cannot load this card">
                    {card.error.message}
                </Alert>
                <Anchor component={Link} to="/" size="sm">
                    ← Back to the board
                </Anchor>
            </Stack>
        );
    }

    if (!card.data) return <Loader size="sm" />;

    return (
        <CardDetailView
            card={card.data}
            events={events.data}
            eventsLimit={HISTORY_LIMIT}
            eventsError={events.error}
            versions={versions.data}
            versionsLimit={HISTORY_LIMIT}
            versionsError={versions.error}
        />
    );
}

export const Route = createFileRoute('/cards/$cardId')({ component: CardDetailRoute });
