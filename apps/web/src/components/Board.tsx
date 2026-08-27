import { useState } from 'react';
import { Badge, Box, Group, Loader, Paper, ScrollArea, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
    DndContext,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { PARKING_LOT, columnOrder, groupByStage, stagesById, unfinishedDeps } from '#src/lib/board.js';
import { useMoveCard, useRepositionCard } from '#src/lib/mutations.js';

/**
 * Terminal states and the parking lot read as quieter than the stages a card is moving through.
 * Exported so the card detail view colours its stage badge the same way the board does.
 */
export const TONE: Record<string, string> = {
    'parking-lot': 'gray',
    planning: 'cyan',
    backlog: 'indigo',
    implementing: 'blue',
    testing: 'violet',
    review: 'grape',
    ready: 'teal',
    merged: 'green',
    poisoned: 'red',
    dropped: 'gray',
};

/**
 * The card's visual body, shared between the card sitting in its column and the `DragOverlay`
 * copy that follows the pointer while it's picked up — dnd-kit portals the overlay elsewhere in
 * the DOM, so it needs its own render of the same look rather than being reachable through a ref.
 *
 * `pending` covers the request-in-flight look card 0046 adds: the card is still in its old column
 * (the drag is animation, not state — PROJECT.md, Architecture; card 0037), so without this a slow
 * API reads as nothing having happened.
 */
function CardBody({ card, blockedBy, pending }: { card: CardSummary; blockedBy: string[]; pending: boolean }) {
    return (
        <Paper withBorder p="xs" radius="sm" style={card.needsHuman ? { borderColor: 'var(--mantine-color-red-6)' } : undefined}>
            <Group gap={6} wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed" ff="monospace">
                    {card.id}
                </Text>
                <Text size="sm" style={{ lineHeight: 1.3, flex: 1 }}>
                    {card.title}
                </Text>
                {pending && <Loader size={12} />}
            </Group>
            {(card.needsHuman || blockedBy.length > 0) && (
                <Group gap={6} mt={6}>
                    {card.needsHuman && (
                        <Badge size="xs" color="red" variant="light">
                            {card.needsHumanReason ?? 'needs human'}
                        </Badge>
                    )}
                    {blockedBy.length > 0 && (
                        <Badge size="xs" color="orange" variant="light">
                            blocked on {blockedBy.join(', ')}
                        </Badge>
                    )}
                </Group>
            )}
        </Paper>
    );
}

/**
 * A card in its column: a `Link` (a click still opens `/cards/$cardId`) that is also a dnd-kit
 * draggable keyed by the card's id. `Board`'s pointer sensor only starts a drag past a few pixels
 * of movement — without that activation constraint every click would clear the threshold at 0px
 * and the board would stop navigating, which is the one thing dragging must not break.
 */
function Card({ card, blockedBy, pending }: { card: CardSummary; blockedBy: string[]; pending: boolean }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id });
    return (
        <Link
            ref={setNodeRef}
            to="/cards/$cardId"
            params={{ cardId: card.id }}
            style={{ display: 'block', textDecoration: 'none', color: 'inherit', opacity: isDragging ? 0.4 : 1 }}
            {...attributes}
            {...listeners}
        >
            <CardBody card={card} blockedBy={blockedBy} pending={pending} />
        </Link>
    );
}

/**
 * A card in the parking lot: the same `Link`-as-draggable `Card` renders elsewhere, but wired
 * through dnd-kit's `useSortable` instead of a plain `useDraggable` — `useSortable` is also a
 * droppable keyed by the card's own id, which is what lets a drop resolve onto a specific card
 * (`Board`'s `handleDragEnd` tells a reorder from a cross-column move by whether `over` is a card id
 * or a stage id). `transform`/`transition` are applied by hand rather than through
 * `@dnd-kit/utilities`'s `CSS` helper — this package isn't a dependency of `apps/web` and the plan
 * adds exactly one (`@dnd-kit/sortable`) — so the other parking-lot cards visibly slide out of the
 * way while one is picked up.
 */
function SortableCard({ card, blockedBy, pending }: { card: CardSummary; blockedBy: string[]; pending: boolean }) {
    const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({ id: card.id });
    return (
        <Link
            ref={setNodeRef}
            to="/cards/$cardId"
            params={{ cardId: card.id }}
            style={{
                display: 'block',
                textDecoration: 'none',
                color: 'inherit',
                opacity: isDragging ? 0.4 : 1,
                transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
                transition: transition ?? undefined,
            }}
            {...attributes}
            {...listeners}
        >
            <CardBody card={card} blockedBy={blockedBy} pending={pending} />
        </Link>
    );
}

/**
 * A column is a dnd-kit droppable keyed by its stage. `isOver` only paints a highlight — it is not
 * a verdict on whether the drop is legal. The stage graph (`validTargets`) lives on the API, and
 * the refusal that counts is the one it sends back through `useMoveCard`'s notification, not
 * anything decided here.
 *
 * Only the parking lot's cards sit in a `SortableContext` (card 0047: ordering applies there and
 * nowhere else) — every other column keeps rendering plain, non-sortable `Card`s, so a card outside
 * the parking lot is never itself a drop target and can't be reordered.
 */
function Column({
    stage,
    cards,
    stageById,
    pendingId,
}: {
    stage: string;
    cards: CardSummary[];
    stageById: Map<string, string>;
    pendingId: string | null;
}) {
    const { setNodeRef, isOver } = useDroppable({ id: stage });
    const isParkingLot = stage === PARKING_LOT;
    return (
        <Stack
            ref={setNodeRef}
            gap="xs"
            w={260}
            p={4}
            style={{
                flex: '0 0 auto',
                borderRadius: 'var(--mantine-radius-sm)',
                backgroundColor: isOver ? 'var(--mantine-color-blue-light)' : undefined,
            }}
        >
            <Group gap="xs" justify="space-between">
                <Badge color={TONE[stage] ?? 'gray'} variant="light" radius="sm">
                    {stage}
                </Badge>
                <Text size="xs" c="dimmed">
                    {cards.length}
                </Text>
            </Group>
            <Stack gap={6} mih={24}>
                {isParkingLot ? (
                    <SortableContext items={cards.map(card => card.id)} strategy={verticalListSortingStrategy}>
                        {cards.map(card => (
                            <SortableCard key={card.id} card={card} blockedBy={unfinishedDeps(card, stageById)} pending={card.id === pendingId} />
                        ))}
                    </SortableContext>
                ) : (
                    cards.map(card => (
                        <Card key={card.id} card={card} blockedBy={unfinishedDeps(card, stageById)} pending={card.id === pendingId} />
                    ))
                )}
            </Stack>
        </Stack>
    );
}

/**
 * The board: a column per stage, cards in the one they are in.
 *
 * Columns come from the API rather than a list in here, because stages are config — a board that
 * hard-codes them starts lying the first time a stage is added.
 *
 * Dragging a card to another column reuses card 0037's `useMoveCard` — the same write the card
 * detail's move control makes, bound to whichever card is currently picked up. `onDragEnd` is the
 * only place that calls it, and only when the column dropped on differs from the card's own stage;
 * nothing here writes the moved card into `cards` or `grouped`, so the card stays in its starting
 * column — reading as pending — until the feed's invalidation brings back a board that agrees the
 * move happened, or a refusal notification says why it didn't.
 *
 * Dragging a card within the parking lot is different on purpose (card 0047's plan, and PROJECT.md,
 * Architecture): it is the one optimistic write on this board. `handleDragEnd` tells the two apart
 * by where the drop landed — `over.id` is a stage id for every column (only the outer `Stack` is
 * droppable there) but can be a card's own id inside the parking lot (its cards are individually
 * droppable through `SortableContext`/`useSortable`). Landing on a parking-lot card while dragging
 * from the parking lot is a reorder, handled by `reorderParkingLot` and `useRepositionCard`, which
 * writes the new order into the `['cards']` query cache immediately rather than waiting on a
 * refetch. Landing on the parking lot from another column, or on a parking-lot card from another
 * column, is still a stage move — `useMoveCard`, unchanged — never a reorder.
 */
export function Board({
    columns,
    cards,
    allCards,
}: {
    columns: BoardColumns;
    cards: CardSummary[];
    /**
     * The full card set to resolve dependency stages against, when `cards` is a filtered subset
     * (card 0119's `/flagged` view, for one). Falls back to `cards` itself so a dependency on a
     * card outside the filtered set doesn't read as unfinished just because it's missing from the
     * lookup — see `unfinishedDeps` in `lib/board.ts`.
     */
    allCards?: CardSummary[];
}) {
    const order = columnOrder(columns, cards);
    const grouped = groupByStage(cards);
    const stageById = stagesById(allCards ?? cards);

    // The card currently picked up, for the `DragOverlay`, and the card whose move is in flight —
    // two different things, since the drag itself ends (and the overlay disappears) well before the
    // API answers. `useMoveCard` is bound to `activeId`: it is only ever mutated from `handleDragEnd`
    // below, by which point a render has already committed with the id the drop just reported.
    const [activeId, setActiveId] = useState<string | null>(null);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const moveCard = useMoveCard(activeId ?? '');
    const repositionCard = useRepositionCard();

    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor));

    const activeCard = activeId ? cards.find(card => card.id === activeId) : undefined;

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    };

    /**
     * Reorders the parking lot: `overId` is either another parking-lot card's id (drop landed on
     * it) or `PARKING_LOT` itself (drop landed on empty column space, past the last card — treated
     * as "to the bottom"). Computes the new order with dnd-kit's own `arrayMove`, stamps every
     * parking-lot card with a synthetic 0-based `position` matching that order (standing in for the
     * server's real, sparse one until the response or a feed event replaces it — `groupByStage`
     * only ever sorts by whatever `position` says, so the reorder has to show up there to be visible
     * at all), and hands the whole thing to `useRepositionCard` to write into the cache and send.
     *
     * `beforeId`/`afterId` name the card's new neighbours by id (`RepositionCardRequest`), not by
     * the position value itself — the endpoint computes its own value to land between them.
     */
    const reorderParkingLot = (cardId: string, overId: string) => {
        const parkingLotCards = grouped.get(PARKING_LOT) ?? [];
        const oldIndex = parkingLotCards.findIndex(card => card.id === cardId);
        const newIndex = overId === PARKING_LOT ? parkingLotCards.length - 1 : parkingLotCards.findIndex(card => card.id === overId);
        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

        const reordered = arrayMove(parkingLotCards, oldIndex, newIndex);
        const rank = new Map(reordered.map((card, index) => [card.id, index]));
        const optimisticCards = cards.map(card => (rank.has(card.id) ? { ...card, position: rank.get(card.id) } : card));
        const beforeId = newIndex > 0 ? reordered[newIndex - 1]?.id : undefined;
        const afterId = newIndex < reordered.length - 1 ? reordered[newIndex + 1]?.id : undefined;

        repositionCard.mutate({ id: cardId, beforeId, afterId, optimisticCards });
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const cardId = String(event.active.id);
        const overId = event.over ? String(event.over.id) : undefined;
        if (!overId) {
            setActiveId(null);
            return;
        }
        const sourceStage = stageById.get(cardId);
        // `over.id` is a stage id for a drop on a column's own droppable — every column but the
        // parking lot (see `Column` above) — and a card id for a drop on a parking-lot card;
        // resolving it to that card's own stage covers both.
        const overStage = order.includes(overId) ? overId : stageById.get(overId);

        if (sourceStage === PARKING_LOT && overStage === PARKING_LOT) {
            reorderParkingLot(cardId, overId);
            setActiveId(null);
            return;
        }

        const targetStage = overStage;
        if (!targetStage || targetStage === sourceStage) {
            setActiveId(null);
            return;
        }
        setPendingId(cardId);
        // Deliberately NOT `setActiveId(null)` here. `useMoveCard(id)` rebuilds its `mutationFn` (a
        // fresh closure over `id`) on every render; TanStack Query's `MutationObserver` keeps one
        // instance across renders and reads whichever `mutationFn` is current on the render that
        // commits before the mutation's internal `await onMutate?.()` resumes — not the one current
        // when `.mutate()` was called. Clearing `activeId` synchronously here would force exactly
        // that re-render, so the request would carry `''` instead of the card being moved. Hold
        // `activeId` until the mutation settles — the same moment `pendingId` already clears.
        moveCard.mutate(targetStage, {
            onSettled: () => {
                setPendingId(null);
                setActiveId(null);
            },
        });
    };

    return (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveId(null)}>
            <ScrollArea type="auto">
                <Box pb="md">
                    <Group align="flex-start" gap="lg" wrap="nowrap">
                        {order.map(stage => (
                            <Column key={stage} stage={stage} cards={grouped.get(stage) ?? []} stageById={stageById} pendingId={pendingId} />
                        ))}
                    </Group>
                </Box>
            </ScrollArea>
            <DragOverlay>
                {activeCard ? <CardBody card={activeCard} blockedBy={unfinishedDeps(activeCard, stageById)} pending={false} /> : null}
            </DragOverlay>
        </DndContext>
    );
}

export function BoardTitle({ count }: { count: number }) {
    return (
        <Title order={5} fw={500}>
            {count} cards
        </Title>
    );
}
