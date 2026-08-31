import { Group, Skeleton, Stack } from '@mantine/core';

/**
 * Card 0175: stands in for the board while its first `listBoardColumns`/`listCards` fetch is still
 * in flight — both `projects.$project.index.tsx` and its `/flagged` sibling used to render a bare
 * `<Loader size="sm" />` there, which reads as "something is wrong" rather than "the board is
 * coming" on a cold load. A handful of column-shaped, tile-shaped `Skeleton`s approximates the
 * board's own layout (`Board.tsx`'s `Column`/`CardBody`) closely enough to read as a placeholder
 * for it, without importing anything from that file — this component is deliberately independent of
 * `Board.tsx`'s internals, which are out of this card's scope.
 *
 * `Skeleton` is Mantine's own component, so it already follows the active colour scheme with no
 * extra wiring here.
 */
export function BoardSkeleton() {
    return (
        <Group align="flex-start" gap="lg" wrap="nowrap" data-testid="board-skeleton">
            {Array.from({ length: 5 }, (_, columnIndex) => (
                <Stack key={columnIndex} gap="xs" w={260} p={4} style={{ flex: '0 0 auto' }}>
                    <Skeleton height={20} width={90} radius="sm" />
                    <Stack gap={6}>
                        {Array.from({ length: 3 }, (_, tileIndex) => (
                            <Skeleton key={tileIndex} height={52} radius="sm" />
                        ))}
                    </Stack>
                </Stack>
            ))}
        </Group>
    );
}
