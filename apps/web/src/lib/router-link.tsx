import { forwardRef } from 'react';
import { createLink, type LinkComponent } from '@tanstack/react-router';
import { Anchor, type AnchorProps } from '@mantine/core';

/**
 * Card 0153. Mantine's `component={Link}` erases TanStack's route-specific `params` typing — fine
 * for the app's existing `component={Link}` spots (`FlaggedIndicator`, `settings.tsx`,
 * `cards.$cardId.tsx`), which only ever target parameterless routes (`to="/"`, `to="/flagged"`), so
 * the erased generic never mattered. Every route this card adds under `/projects/$project/` is not
 * parameterless, and `component={Link}` against one fails with `TS2353: 'project' does not exist` on
 * an `AnyRouter`-typed `params` — the wall six of the nine prior attempts at this card hit.
 *
 * `createLink` is TanStack's own answer to exactly this: it wraps a component as a typed `Link`, so a
 * `params` mismatch is still a compile error and `to`/`params` still autocomplete. Handing it
 * Mantine's `Anchor` directly (`createLink(Anchor)`) type-checks for `to`/`params`/`children` but
 * loses every one of `Anchor`'s own props (`size`, `c`, …) — `Anchor` is polymorphic
 * (`PolymorphicComponentProps<C, AnchorProps>`), and `createLink`'s generic does not merge into that
 * shape. Routing `Anchor` through one concrete `forwardRef` first, the way TanStack's own docs show
 * for a polymorphic UI-library component, fixes it: `createLink` sees a plain `(props, ref) =>
 * ReactNode`, and `Anchor`'s props come along because `MantineAnchor` declares them itself.
 *
 * This is the one approach used everywhere this card links to a parameterised route; every existing,
 * parameterless `component={Link}` usage is left exactly as it was.
 *
 * Card 0155: `settings.tsx`'s and `CardDetail.tsx`'s own `component={Link}` spots above stopped
 * being parameterless once their "back to board" target moved under `/projects/$project` — both now
 * use `AnchorLink` too. `FlaggedIndicator`'s `/flagged` badge hit the same wall but isn't an
 * `Anchor`; rather than add a second `createLink`-wrapped component for `Badge`, it wraps a plain
 * `Link` around the badge instead — no polymorphic `component` prop, so no erased typing to fix.
 * `cards.$cardId.tsx`, the third spot named above, no longer exists.
 */
const MantineAnchor = forwardRef<HTMLAnchorElement, Omit<AnchorProps, 'href'>>((props, ref) => <Anchor ref={ref} {...props} />);

const CreatedAnchorLink = createLink(MantineAnchor);

export const AnchorLink: LinkComponent<typeof MantineAnchor> = props => <CreatedAnchorLink {...props} />;
