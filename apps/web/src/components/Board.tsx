import { Badge, Box, Group, Paper, ScrollArea, Stack, Text, Title } from '@mantine/core';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { columnOrder, groupByStage, stagesById, unfinishedDeps } from '#src/lib/board.js';

/** Terminal states and the parking lot read as quieter than the stages a card is moving through. */
const TONE: Record<string, string> = {
    'parking-lot': 'gray',
    implementing: 'blue',
    testing: 'violet',
    review: 'grape',
    ready: 'teal',
    merged: 'green',
    'needs-human': 'orange',
    poisoned: 'red',
    dropped: 'gray',
};

function Card({ card, blockedBy }: { card: CardSummary; blockedBy: string[] }) {
    return (
        <Paper withBorder p="xs" radius="sm">
            <Group gap={6} wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed" ff="monospace">
                    {card.id}
                </Text>
                <Text size="sm" style={{ lineHeight: 1.3 }}>
                    {card.title}
                </Text>
            </Group>
            {blockedBy.length > 0 && (
                <Badge size="xs" color="orange" variant="light" mt={6}>
                    blocked on {blockedBy.join(', ')}
                </Badge>
            )}
        </Paper>
    );
}

function Column({ stage, cards, stageById }: { stage: string; cards: CardSummary[]; stageById: Map<string, string> }) {
    return (
        <Stack gap="xs" w={260} style={{ flex: '0 0 auto' }}>
            <Group gap="xs" justify="space-between">
                <Badge color={TONE[stage] ?? 'gray'} variant="light" radius="sm">
                    {stage}
                </Badge>
                <Text size="xs" c="dimmed">
                    {cards.length}
                </Text>
            </Group>
            <Stack gap={6}>
                {cards.map(card => (
                    <Card key={card.id} card={card} blockedBy={unfinishedDeps(card, stageById)} />
                ))}
            </Stack>
        </Stack>
    );
}

/**
 * The board: a column per stage, cards in the one they are in.
 *
 * Columns come from the API rather than a list in here, because stages are config — a board that
 * hard-codes them starts lying the first time a stage is added.
 */
export function Board({ columns, cards }: { columns: BoardColumns; cards: CardSummary[] }) {
    const order = columnOrder(columns, cards);
    const grouped = groupByStage(cards);
    const stageById = stagesById(cards);

    return (
        <ScrollArea type="auto">
            <Box pb="md">
                <Group align="flex-start" gap="lg" wrap="nowrap">
                    {order.map(stage => (
                        <Column key={stage} stage={stage} cards={grouped.get(stage) ?? []} stageById={stageById} />
                    ))}
                </Group>
            </Box>
        </ScrollArea>
    );
}

export function BoardTitle({ count }: { count: number }) {
    return (
        <Title order={5} fw={500}>
            {count} cards
        </Title>
    );
}
