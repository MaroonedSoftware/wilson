import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Loader, Stack } from '@mantine/core';
import { CardDetailView } from '#src/components/CardDetail.js';
import { wilsonForProject } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';
import { AnchorLink } from '#src/lib/router-link.js';

/** `limit` passed to both history endpoints, matching `cards.$cardId.tsx`. */
const HISTORY_LIMIT = 50;

/**
 * Card 0153: a card's own page at a project-scoped URL, `/projects/$project/cards/$cardId` — this is
 * the fix the card exists for: pasting this URL always opens the card it names, in the project it
 * names, unlike `/cards/$cardId` once two projects' boards both have the same card id.
 *
 * Reads through `wilsonForProject(project)` rather than the singleton `wilson`, and passes `project`
 * on to `CardDetailView` so the planning stream it may open (`usePlanTranscript`, via
 * `PlanningSessionPane`) also names it. `CardDetailView`'s own "back to board" link, and every link a
 * `Board`/`Markdown` card reference produces, still point at the top-level routes — migrating those is
 * [[0155]]'s job, not this card's; only the error state's own link below, written for this route, is
 * new enough to get it right immediately (`AnchorLink`, this card's chosen fix for `component={Link}`
 * against a parameterised route).
 *
 * Card 0156: wraps its render tree in `WilsonSdkProvider` with `client`, so `CardDetailView` and the
 * `PlanningSessionPane` it may render read this project's client through `useWilsonSdk()` rather than
 * the unscoped default `__root.tsx` supplies.
 */
function ProjectCardDetailRoute() {
    const { project, cardId } = Route.useParams();
    const client = useMemo(() => wilsonForProject(project), [project]);

    const card = useQuery({ queryKey: ['project', project, 'card', cardId], queryFn: () => client.board.getCard(cardId) });
    const events = useQuery({
        queryKey: ['project', project, 'card', cardId, 'events'],
        queryFn: () => client.board.listCardEvents(cardId, { limit: HISTORY_LIMIT }),
    });
    const versions = useQuery({
        queryKey: ['project', project, 'card', cardId, 'versions'],
        queryFn: () => client.board.listCardVersions(cardId, { limit: HISTORY_LIMIT }),
    });
    const columns = useQuery({ queryKey: ['project', project, 'columns'], queryFn: () => client.board.listBoardColumns() });
    // Card 0189: keyed `[..., cardId, 'context']`, one segment longer than the card's own
    // `[..., 'card', cardId]` key — `lib/mutations.ts`'s `matchesContextList` is written to match
    // exactly this shape, not `matchesCard`'s (this card's Constraints).
    const context = useQuery({
        queryKey: ['project', project, 'card', cardId, 'context'],
        queryFn: () => client.context.listCardContext(cardId),
    });

    if (card.error) {
        return (
            <Stack gap="sm">
                <Alert color="red" title="Cannot load this card">
                    {card.error.message}
                </Alert>
                <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                    ← Back to the board
                </AnchorLink>
            </Stack>
        );
    }

    if (!card.data) return <Loader size="sm" />;

    return (
        <WilsonSdkProvider client={client}>
            <CardDetailView
                card={card.data}
                events={events.data}
                eventsLimit={HISTORY_LIMIT}
                eventsError={events.error}
                versions={versions.data}
                versionsLimit={HISTORY_LIMIT}
                versionsError={versions.error}
                context={context.data}
                contextError={context.error}
                columns={columns.data}
                columnsError={columns.error}
                project={project}
            />
        </WilsonSdkProvider>
    );
}

export const Route = createFileRoute('/projects/$project/cards/$cardId')({ component: ProjectCardDetailRoute });
