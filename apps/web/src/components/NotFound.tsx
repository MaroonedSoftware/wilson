import { Link } from '@tanstack/react-router';
import { Stack, Text, Title } from '@mantine/core';
import { WilsonMark } from '#src/components/brand/WilsonMark.js';

/**
 * What renders for any URL the router can't match (card 0173). Wired as `createRouter`'s
 * `defaultNotFoundComponent` (`main.tsx`), not a `notFoundComponent` on any one route — there's
 * nothing route-specific to say here, and a default at the router level catches every unmatched path
 * without every route having to opt in.
 *
 * Before this card an unmatched path hit TanStack Router's own built-in fallback: a bare, unstyled
 * "Not Found" with no way back except the browser's own back button. Links home instead — `/` is the
 * dashboard (card 0169), a real page with the registered projects on it, not a redirect and not a
 * second copy of the header's own home link (`__root.tsx`'s `Link to="/"` around `WilsonMark` and
 * the `wilson` title stays the only *header* affordance; this is the in-page one for whoever actually
 * landed on this screen).
 */
export function NotFound() {
    return (
        <Stack align="center" gap="xs" py="xl">
            <WilsonMark size={48} />
            <Title order={3}>Page not found</Title>
            <Text c="dimmed">There's nothing at this address.</Text>
            <Link to="/">Back to the dashboard</Link>
        </Stack>
    );
}
