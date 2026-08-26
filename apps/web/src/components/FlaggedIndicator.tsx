import { Badge } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { wilson } from '#src/lib/sdk.js';

/**
 * How many cards need a human, wherever they sit on the board (card 0119).
 *
 * Card 0057's red border and badge are the right treatment once you're looking at the right
 * column — this is the thing that tells you to look. It reads the same `['cards']` query the feed
 * (`lib/feed.ts`) already keeps fresh by invalidating on every SSE event, so a card flagged, acked,
 * or moved while this is on screen updates the count with no poll and no second subscription: this
 * is just another consumer of the one cache entry the feed already drives.
 *
 * Renders nothing at zero. This sits in the header on every page, permanently — a badge reading
 * "0" would be noise an operator has to learn to ignore, which is the exact failure mode an
 * always-on indicator has to avoid.
 */
export function FlaggedIndicator() {
    const cards = useQuery({ queryKey: ['cards'], queryFn: () => wilson.board.listCards() });
    const count = cards.data?.filter(card => card.needsHuman).length ?? 0;

    if (count === 0) return null;

    return (
        <Badge
            component={Link}
            to="/flagged"
            color="red"
            variant="filled"
            size="sm"
            style={{ cursor: 'pointer', textDecoration: 'none' }}
        >
            {count} needs human
        </Badge>
    );
}
