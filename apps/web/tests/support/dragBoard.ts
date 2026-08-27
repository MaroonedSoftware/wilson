// Card 0136: a faithful stand-in for the drag-capable `Board` committed on
// `card/0046-drag-a-card-between-columns` (commit 5c66c78, `apps/web/src/components/Board.tsx`).
//
// That card's Board.tsx is explicitly out of scope here — 0046 is not merged, so this worktree's
// `apps/web/src/components/Board.tsx` is still the pre-drag version, and the plan is clear that any
// change to `apps/web/src/**` belongs to 0046, not to this card. What this card owns is proving a
// drop can be asserted at all under jsdom; this component reproduces exactly the DOM shape 0046's
// Board.tsx renders (the same `DndContext` / droppable `Stack` / draggable `Link+Paper` /
// `ScrollArea` nesting, the same sensors, the same `onDragEnd` call into `useMoveCard`) so the rect
// stub in `rectStub.ts` is proven against the real failure mode, not a simplified tree that happens
// not to trigger it. `data-testid`s are added purely for this test to find its own elements; they
// are not something 0046's Board.tsx needs, and are not part of what the stub matches on (the stub
// matches by Mantine's own class names, which 0046's Board.tsx already has) so the same rule set
// applies unchanged once this logic is folded back into Board.tsx.
import { createElement, useState } from 'react';
import { Badge, Box, Group, Loader, Paper, ScrollArea, Stack, Text } from '@mantine/core';
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
import type { CardSummary } from '@wilson/sdk';
import { useMoveCard } from '#src/lib/mutations.js';

const e = createElement;

function CardBody({ card, pending }: { card: CardSummary; pending: boolean }) {
    return e(
        Paper,
        { withBorder: true, p: 'xs', radius: 'sm' },
        e(
            Group,
            { gap: 6, wrap: 'nowrap', align: 'baseline' },
            e(Text, { size: 'xs', c: 'dimmed', ff: 'monospace' }, card.id),
            e(Text, { size: 'sm' }, card.title),
            pending ? e(Loader, { size: 12 }) : null,
        ),
    );
}

function DragCard({ card, pending }: { card: CardSummary; pending: boolean }) {
    const { attributes, listeners, setNodeRef } = useDraggable({ id: card.id });
    return e(
        'a',
        { ref: setNodeRef, href: '#', 'data-testid': `card-${card.id}`, ...attributes, ...listeners },
        e(CardBody, { card, pending }),
    );
}

function DragColumn({ stage, cards, pendingId }: { stage: string; cards: CardSummary[]; pendingId: string | null }) {
    const { setNodeRef, isOver } = useDroppable({ id: stage });
    return e(
        Stack,
        { ref: setNodeRef, gap: 'xs', w: 260, p: 4, 'data-testid': `column-${stage}`, 'data-over': isOver },
        e(Group, { gap: 'xs', justify: 'space-between' }, e(Badge, { variant: 'light', radius: 'sm' }, stage)),
        e(
            Stack,
            { gap: 6, mih: 24 },
            cards.map(card => e(DragCard, { key: card.id, card, pending: card.id === pendingId })),
        ),
    );
}

/**
 * Same shape as 0046's `Board`, trimmed of the props (`columns`, `allCards`) this card's tests do
 * not need — every column here is one this test explicitly asked for, in the order given.
 */
export function DragBoard({ order, grouped }: { order: string[]; grouped: Map<string, CardSummary[]> }) {
    const [activeId, setActiveId] = useState<string | null>(null);
    const [pendingId, setPendingId] = useState<string | null>(null);
    // Not part of 0046's Board.tsx — a test-only window onto `event.over` so a negative test ("no
    // move happened") can prove the drop still resolved to a real droppable, rather than passing
    // because `over` silently stayed null (the constraint that made two of 0046's five preserved
    // tests worthless — see board.drag.test.ts).
    const [lastOverStage, setLastOverStage] = useState<string>('(none yet)');
    const moveCard = useMoveCard(activeId ?? '');
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor));
    const stageById = new Map(order.flatMap(stage => (grouped.get(stage) ?? []).map(card => [card.id, stage] as const)));
    const activeCard = activeId ? order.flatMap(stage => grouped.get(stage) ?? []).find(card => card.id === activeId) : undefined;

    const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
    const handleDragEnd = (event: DragEndEvent) => {
        const cardId = String(event.active.id);
        const targetStage = event.over ? String(event.over.id) : undefined;
        setLastOverStage(targetStage ?? '(null — no droppable resolved)');
        if (!targetStage || targetStage === stageById.get(cardId)) {
            setActiveId(null);
            return;
        }
        setPendingId(cardId);
        // Deliberately NOT `setActiveId(null)` here — see this card's report and
        // `board.drag.test.ts`'s "the id the request actually carries" test. `useMoveCard(id)`
        // rebuilds its `mutationFn` (a fresh closure over `id`) on every render; TanStack Query's
        // `MutationObserver` keeps ONE instance across renders and reads whichever `mutationFn` is
        // current on the render that finishes *before* the mutation's own internal `await`
        // resumes — not the one current when `.mutate()` was called. Clearing `activeId` in this
        // same handler (0046's committed Board.tsx does exactly that, immediately after
        // `moveCard.mutate(...)`) forces a re-render with `activeId: null` in that window, so the
        // request that goes out is bound to `''`, not the card actually being moved. Holding
        // `activeId` until the mutation settles closes that window — the same reasoning
        // `pendingId` (also cleared `onSettled`) already follows one line below.
        moveCard.mutate(targetStage, {
            onSettled: () => {
                setPendingId(null);
                setActiveId(null);
            },
        });
    };

    return e(
        'div',
        null,
        e(
            DndContext,
            { sensors, onDragStart: handleDragStart, onDragEnd: handleDragEnd, onDragCancel: () => setActiveId(null) },
            e(
                ScrollArea,
                { type: 'auto' },
                e(
                    Box,
                    { pb: 'md' },
                    e(
                        Group,
                        { align: 'flex-start', gap: 'lg', wrap: 'nowrap' },
                        order.map(stage => e(DragColumn, { key: stage, stage, cards: grouped.get(stage) ?? [], pendingId })),
                    ),
                ),
            ),
            e(DragOverlay, null, activeCard ? e(CardBody, { card: activeCard, pending: false }) : null),
        ),
        e('span', { 'data-testid': 'last-over-stage' }, lastOverStage),
    );
}
