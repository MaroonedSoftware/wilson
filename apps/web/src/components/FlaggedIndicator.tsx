import { Badge } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

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
 *
 * Card 0156: reads its client through `useWilsonSdk()` — rendered in `__root.tsx`'s header, above
 * every route's `Outlet`, so this always resolves to `__root.tsx`'s own unscoped default regardless
 * of which route matched below, exactly the singleton this used to import directly.
 *
 * Card 0155: `/flagged` moved to `/projects/$project/flagged`, a parameterised route the badge's
 * `count` (from the same unscoped client) can't name via the currently-matched route's own params —
 * that would point at whichever project happens to be on screen, not the project this count is
 * actually for. Reads `health.data.project` instead: the same unscoped client's own configured
 * project, matching what `['cards']` above just counted. Also sidesteps `component={Link}`'s erased
 * `params` typing (this card's Constraints) by wrapping the badge in a plain `Link` instead of
 * handing it in as `component` — simpler here than a second `createLink` wrapper for `Badge`.
 */
export function FlaggedIndicator() {
    const wilson = useWilsonSdk();
    const cards = useQuery({ queryKey: ['cards'], queryFn: () => wilson.board.listCards() });
    const health = useQuery({ queryKey: ['health'], queryFn: () => wilson.health.getHealth() });
    const count = cards.data?.filter(card => card.needsHuman).length ?? 0;

    if (count === 0 || !health.data) return null;

    return (
        <Link to="/projects/$project/flagged" params={{ project: health.data.project }} style={{ textDecoration: 'none' }}>
            <Badge color="red" variant="filled" size="sm" style={{ cursor: 'pointer' }}>
                {count} needs human
            </Badge>
        </Link>
    );
}
