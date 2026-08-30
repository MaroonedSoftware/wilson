// @vitest-environment jsdom
//
// Card 0047 ("Order the parking lot"): the reorder half of `Board.tsx`'s drag handling —
// `reorderParkingLot`/`handleDragEnd`'s branch that tells a same-column drop on a parking-lot card
// apart from a stage move, plus `useRepositionCard` (lib/mutations.ts) and `groupByStage`'s
// position-based sort (lib/board.ts) that make the reordered column actually render. Exercises the
// real `Board.tsx`, the same way board.dnd.test.ts does for the cross-column case (this card's plan
// says the two must never share a code path, so this file, not that one) — same `rectStub.ts` and
// `renderApp` harness, and the same keyboard-drag sequencing card 0136/0046 already worked out
// (`Space` to pick up, an arrow key repeated to move, `Space` to drop, yielding a tick after pickup
// for `KeyboardSensor.attach`'s own `setTimeout(0)`).
//
// A drop inside a single column moves the dragged rect only in `y`, not `x` — dnd-kit's
// `defaultKeyboardCoordinateGetter` (node_modules/@dnd-kit/core) adds exactly 25px per `ArrowDown`,
// the vertical twin of board.dnd.test.ts's horizontal `STEP`. Each parking-lot card gets its own
// non-overlapping 25px-tall rect stacked at `index * STEP`, so one `ArrowDown` per card crossed lands
// squarely on the next one, deterministically.
//
// Card 0155 deleted the top-level `/` board — this file now opens the same board at its
// project-scoped URL, `/projects/demo`, whose route reads through `wilsonForProject(project)`
// (`projects.$project.index.tsx`) rather than the singleton `wilson` this file used to mock
// directly. The mock moves to `BoardClient`'s own prototype (shared by every instance, the
// singleton included) — the same fix `project-routes.test.ts` made for the same reason.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { BoardClient, SdkError } from '@wilson/sdk';
import { columnOrder } from '#src/lib/board.js';
import { routeTree } from '#src/routeTree.gen.js';
import { byClass, byElement, withStubbedRects, type RectRule } from './support/rectStub.js';

/** Every test below opens the board at this project-scoped URL. */
const BOARD_PATH = '/projects/demo';

const card = (id: string, stage: string, position?: number): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn: [],
    needsHuman: false,
    position,
});

const COLUMNS: BoardColumns = { stages: ['implementing', 'testing', 'review'], nonStages: [] };
const ORDER = columnOrder(COLUMNS, []); // ['parking-lot', 'implementing', 'testing', 'review']

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient();
    render(
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
        ),
    );
    return { router };
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    );
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal(
        'EventSource',
        class {
            addEventListener() {}
            close() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const STEP = 25; // dnd-kit's `defaultKeyboardCoordinateGetter` moves an `ArrowDown` by exactly this many px.

/** The droppable `Stack` for the parking lot: the nearest `.mantine-Stack-root` ancestor of its badge. */
function parkingLotStack(): HTMLElement {
    const badge = screen.getByText('parking-lot');
    const stack = badge.closest('.mantine-Stack-root');
    if (!stack) throw new Error('no droppable Stack ancestor found for the parking lot');
    return stack as HTMLElement;
}

/**
 * Non-overlapping, vertically stacked rects for each parking-lot card (one `STEP` apart, in the
 * order the cards currently render), plus the scroll viewport dnd-kit also measures. The parking
 * lot's own outer `Stack` is deliberately left unstubbed (jsdom's real all-zero rect) — with the
 * cards themselves already covering every position an `ArrowDown` can reach, giving the column a
 * competing overlapping rect too would only risk a tied intersection between "this card" and "the
 * column generally", which is exactly the ambiguity `rectRules` in board.dnd.test.ts sidesteps by
 * giving every droppable a disjoint rect. Matched by element reference, not by class — like
 * board.dnd.test.ts's own columns, the per-card anchors share no distinguishing class.
 */
function cardRectRules(cardIdsInOrder: string[]): RectRule[] {
    const rects = cardIdsInOrder.map((id, index) => {
        const el = screen.getByText(id);
        const anchor = el.closest('a');
        if (!anchor) throw new Error(`could not find draggable anchor for card "${id}"`);
        return { anchor, rect: { x: 10, y: index * STEP, width: 15, height: STEP } };
    });
    return [
        ...rects.map(({ anchor, rect }, i) => byElement(`card anchor ${cardIdsInOrder[i]}`, anchor, rect)),
        // Same reasoning as board.dnd.test.ts's own Paper rule: once picked up, `DragOverlay` mounts
        // a second `CardBody` (a `Paper` sharing the same class) that dnd-kit actually measures: a
        // rule scoped to only the original card's `Paper` would leave that copy at jsdom's zero rect.
        byClass('the card body Paper', 'mantine-Paper-root', rects[0]!.rect),
        byClass('the column row scroll viewport', 'mantine-ScrollArea-viewport', { x: 0, y: 0, width: 4 * STEP, height: 600 }),
    ];
}

async function pickUp(anchor: Element) {
    await act(async () => {
        fireEvent.keyDown(anchor, { code: 'Space' });
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

async function moveDown(anchor: Element) {
    await act(async () => {
        fireEvent.keyDown(anchor, { code: 'ArrowDown' });
    });
}

async function drop(anchor: Element) {
    await act(async () => {
        fireEvent.keyDown(anchor, { code: 'Space' });
    });
}

/** `within(parkingLotStack())`'s visible card ids, top to bottom — the order actually rendered. */
function renderedOrder(): string[] {
    return within(parkingLotStack())
        .getAllByText(/^card \d+$/)
        .map(el => el.textContent!.replace('card ', ''));
}

describe('reordering the parking lot (the real Board.tsx)', () => {
    it('reorders immediately on drop — before the reposition request even settles — and sends the new neighbours', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'parking-lot', 0), card('0002', 'parking-lot', 1), card('0003', 'parking-lot', 2)]);
        // A deliberately unsettled request, the same shape board.dnd.test.ts's own in-flight test
        // uses: proves the reorder is visible immediately (`onMutate`'s cache write), not merely
        // after a fast-resolving mock happens to settle before this test gets around to asserting.
        let resolveReposition!: (value: unknown) => void;
        const repositionCard = vi
            .spyOn(BoardClient.prototype, 'repositionCard')
            .mockImplementation(() => new Promise(resolve => (resolveReposition = resolve)));

        renderApp(BOARD_PATH);
        await screen.findByText('card 0001');
        const anchor = screen.getByText('0001').closest('a')!;

        await withStubbedRects(cardRectRules(['0001', '0002', '0003']), async () => {
            await pickUp(anchor);
            await moveDown(anchor); // onto card 0002's rect
            await drop(anchor);
        });

        // `0001` now sits between `0002` and `0003` — named by id, per `RepositionCardRequest`.
        await waitFor(() => expect(repositionCard).toHaveBeenCalledWith('0001', { beforeId: '0002', afterId: '0003' }));
        // Optimistic: the column already reads in the new order, with the request still in flight.
        expect(renderedOrder()).toEqual(['0002', '0001', '0003']);

        await act(async () => {
            resolveReposition({});
            await new Promise(resolve => setTimeout(resolve, 0));
        });
    });

    it("restores the previous order and shows the API's refusal reason when the reposition fails", async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'parking-lot', 0), card('0002', 'parking-lot', 1), card('0003', 'parking-lot', 2)]);
        const repositionCard = vi.spyOn(BoardClient.prototype, 'repositionCard').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'the parking lot changed underneath you' } }, new Headers()),
        );

        renderApp(BOARD_PATH);
        await screen.findByText('card 0001');
        const anchor = screen.getByText('0001').closest('a')!;

        await withStubbedRects(cardRectRules(['0001', '0002', '0003']), async () => {
            await pickUp(anchor);
            await moveDown(anchor);
            await drop(anchor);
        });

        await waitFor(() => expect(repositionCard).toHaveBeenCalledWith('0001', { beforeId: '0002', afterId: '0003' }));
        expect(await screen.findByText('the parking lot changed underneath you')).toBeTruthy();
        // Back the way it was — not left showing the optimistic order the API just refused.
        await waitFor(() => expect(renderedOrder()).toEqual(['0001', '0002', '0003']));
    });

    it('does not call repositionCard when dropped back on the position it started at', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'parking-lot', 0), card('0002', 'parking-lot', 1)]);
        const repositionCard = vi.spyOn(BoardClient.prototype, 'repositionCard').mockResolvedValue({} as never);

        renderApp(BOARD_PATH);
        await screen.findByText('card 0001');
        const anchor = screen.getByText('0001').closest('a')!;

        await withStubbedRects(cardRectRules(['0001', '0002']), async () => {
            await pickUp(anchor);
            // No `moveDown` — dropped exactly where it was picked up, over its own rect.
            await drop(anchor);
        });

        expect(repositionCard).not.toHaveBeenCalled();
        expect(renderedOrder()).toEqual(['0001', '0002']);
    });
});

const XSTEP = 25; // horizontal twin of STEP — one `ArrowRight` crosses exactly one column boundary.

/** The droppable `Stack` for a column: the nearest `.mantine-Stack-root` ancestor of its stage badge. */
function columnStack(stage: string): HTMLElement {
    const badge = screen.getByText(stage);
    const stack = badge.closest('.mantine-Stack-root');
    if (!stack) throw new Error(`no droppable Stack ancestor found for column "${stage}"`);
    return stack as HTMLElement;
}

async function moveRight(anchor: Element) {
    await act(async () => {
        fireEvent.keyDown(anchor, { code: 'ArrowRight' });
    });
}

/**
 * board.dnd.test.ts's own horizontal rect recipe, sized to `ORDER` (which here starts with the
 * parking lot) rather than `board.dnd.test.ts`'s own three-stage `COLUMNS` — proving the reorder
 * branch and the cross-column branch don't interfere needs a drag that actually starts inside the
 * parking lot.
 */
function crossColumnRectRules(cardId: string, startStage: string): RectRule[] {
    const startIndex = ORDER.indexOf(startStage);
    const cardRect = { x: startIndex * XSTEP + 10, y: 10, width: 5, height: 50 };
    const anchor = screen.getByText(cardId).closest('a');
    if (!anchor) throw new Error(`could not find draggable anchor for card "${cardId}"`);
    return [
        ...ORDER.map((stage, i) => byElement(`column ${stage}`, columnStack(stage), { x: i * XSTEP, y: 0, width: XSTEP, height: 600 })),
        byElement('dragged card anchor', anchor, cardRect),
        byClass('the card body Paper', 'mantine-Paper-root', cardRect),
        byClass('the column row scroll viewport', 'mantine-ScrollArea-viewport', { x: 0, y: 0, width: ORDER.length * XSTEP, height: 600 }),
    ];
}

describe('dragging a card out of the parking lot (the real Board.tsx)', () => {
    it('still uses moveCard, not repositionCard — the reorder branch never fires for a cross-column drop', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'parking-lot', 0)]);
        const moveCard = vi.spyOn(BoardClient.prototype, 'moveCard').mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { id: '0001', title: 'card 0001', stage: 'implementing', dependsOn: [], needsHuman: false, sections: {}, body: '' } as any,
        );
        const repositionCard = vi.spyOn(BoardClient.prototype, 'repositionCard');

        renderApp(BOARD_PATH);
        await screen.findByText('card 0001');
        const anchor = screen.getByText('0001').closest('a')!;

        await withStubbedRects(crossColumnRectRules('0001', 'parking-lot'), async () => {
            await pickUp(anchor);
            await moveRight(anchor);
            await drop(anchor);
        });

        await waitFor(() => expect(moveCard).toHaveBeenCalledWith('0001', { stage: 'implementing' }));
        expect(repositionCard).not.toHaveBeenCalled();
        // Non-optimistic, unlike a reorder: the card is still rendered under its starting column
        // while the move is in flight (card 0046's own rule, which this card must not disturb).
        expect(within(columnStack('parking-lot')).getByText('card 0001')).toBeTruthy();
        expect(within(columnStack('implementing')).queryByText('card 0001')).toBeNull();
    });
});

describe('a card outside the parking lot (the real Board.tsx)', () => {
    it('cannot be reordered — a drop elsewhere in its own column resolves to the column itself, not a neighbour card', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0004', 'testing'), card('0005', 'testing')]);
        const moveCard = vi.spyOn(BoardClient.prototype, 'moveCard').mockResolvedValue({} as never);
        const repositionCard = vi.spyOn(BoardClient.prototype, 'repositionCard');

        renderApp(BOARD_PATH);
        await screen.findByText('card 0004');
        const anchor = screen.getByText('0004').closest('a')!;

        const startIndex = ORDER.indexOf('testing');
        const cardRect = { x: startIndex * XSTEP + 10, y: 10, width: 5, height: 50 };
        const rules: RectRule[] = [
            ...ORDER.map((stage, i) => byElement(`column ${stage}`, columnStack(stage), { x: i * XSTEP, y: 0, width: XSTEP, height: 600 })),
            byElement('dragged card anchor', anchor, cardRect),
            byClass('the card body Paper', 'mantine-Paper-root', cardRect),
            byClass('the column row scroll viewport', 'mantine-ScrollArea-viewport', { x: 0, y: 0, width: ORDER.length * XSTEP, height: 600 }),
        ];

        await withStubbedRects(rules, async () => {
            await pickUp(anchor);
            // `testing` isn't the parking lot, so its cards render as plain, non-sortable `Card`s —
            // there is no per-card droppable to land on. Moving straight down (never crossing into
            // another column's `x` range) has nowhere else to resolve to but the column itself.
            await moveDown(anchor);
            await moveDown(anchor);
            await drop(anchor);
        });

        expect(moveCard).not.toHaveBeenCalled();
        expect(repositionCard).not.toHaveBeenCalled();
        // Order within the column is untouched — nothing here is even capable of reordering it.
        const testingColumn = columnStack('testing');
        const ids = within(testingColumn)
            .getAllByText(/^card \d+$/)
            .map(el => el.textContent!.replace('card ', ''));
        expect(ids).toEqual(['0004', '0005']);
    });
});
