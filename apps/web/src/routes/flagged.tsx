import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Anchor, Loader, Stack, Text, Title } from '@mantine/core';
import { Board } from '#src/components/Board.js';
import { wilson } from '#src/lib/sdk.js';

/**
 * Where the header's flagged count (card 0119, `FlaggedIndicator`) sends you: every card needing a
 * human, not a page that just repeats the number.
 *
 * Renders through `Board` itself rather than a second list of cards — the red border, the reason
 * badge and the flagged-first sort are card 0057's, and reusing the same component means this view
 * can only ever narrow *which* cards reach that treatment, never redraw it differently. `columns`
 * is filtered down to the stages a flagged card is actually sitting in, so this reads as "every
 * flagged card, grouped by where it is" rather than the full board with most columns empty.
 */
function FlaggedRoute() {
    const columns = useQuery({ queryKey: ['columns'], queryFn: () => wilson.board.listBoardColumns() });
    const cards = useQuery({ queryKey: ['cards'], queryFn: () => wilson.board.listCards() });

    const error = columns.error ?? cards.error;
    if (error) {
        return (
            <Alert color="red" title="Cannot reach the API">
                {error.message}
            </Alert>
        );
    }
    if (!columns.data || !cards.data) return <Loader size="sm" />;

    const flagged = cards.data.filter(card => card.needsHuman);
    const flaggedStages = new Set(flagged.map(card => card.stage));
    const stagesWithFlagged = {
        stages: columns.data.stages.filter(stage => flaggedStages.has(stage)),
        nonStages: columns.data.nonStages.filter(stage => flaggedStages.has(stage)),
    };

    return (
        <Stack gap="md">
            <Anchor component={Link} to="/" size="sm">
                ← Back to the board
            </Anchor>
            <Title order={4} fw={500}>
                Cards needing a human
            </Title>
            {flagged.length === 0 ? (
                <Text c="dimmed" size="sm">
                    Nothing is flagged right now.
                </Text>
            ) : (
                <Board columns={stagesWithFlagged} cards={flagged} allCards={cards.data} />
            )}
        </Stack>
    );
}

export const Route = createFileRoute('/flagged')({ component: FlaggedRoute });
