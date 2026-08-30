// @vitest-environment jsdom
//
// Card 0046 ("Drag a card between columns"): exercises the real `Board.tsx`, not the stand-in card
// 0136 built (`tests/support/dragBoard.ts`). That stand-in exists purely because `apps/web/src` was
// out of scope for 0136 — it is in scope here, and the plan is explicit that only the shipped
// component proves anything ("Test the real Board.tsx, not dragBoard.ts"). This file borrows
// 0136's proven pieces — `tests/support/rectStub.ts`'s prototype-level rect stub, and the same
// Space/ArrowRight/Space keyboard-drag sequencing dnd-kit's `KeyboardSensor` needs under jsdom — but
// drives the actual route tree (`renderApp`, the same approach `flagged.test.ts` and
// `settings.test.ts` already take), because `Card`'s `Link` needs a real router and `Board`'s
// `useMoveCard` needs the `Notifications` provider `__root.tsx` mounts.
//
// Board.tsx has no test-only hooks (no `data-testid`s) — droppable columns are found by their
// stage-name `Badge` text, walked up to the nearest `.mantine-Stack-root` ancestor, which is the
// column `Stack` `useDroppable`'s `setNodeRef` is attached to (Mantine keeps that class name stable
// across its hashed ones, the same fact `rectStub.ts`'s `byClass` rules already lean on).
//
// Card 0155 deleted the top-level `/` board and its `/cards/$cardId` card page — this file now opens
// the same board at its project-scoped URL, `/projects/demo`, whose route reads through
// `wilsonForProject(project)` (`projects.$project.index.tsx`) rather than the singleton `wilson`
// this file used to mock directly. The mock moves to `BoardClient`'s own prototype (shared by every
// instance, the singleton included) — the same fix `project-routes.test.ts` made for the same
// reason.
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

const card = (id: string, stage: string): CardSummary => ({ id, title: `card ${id}`, stage, dependsOn: [], needsHuman: false });

const COLUMNS: BoardColumns = { stages: ['implementing', 'testing', 'review'], nonStages: [] };

/** `Board` renders inside Mantine's `ScrollArea`, which measures itself with `ResizeObserver`. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

/** Renders the real app router — root layout (feed status, `Notifications`) plus whichever route the path resolves to. */
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
    // jsdom does not implement matchMedia; MantineProvider reads it on mount regardless of what
    // this test renders (the same stub every other test rendering `Board` needs).
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
    // The feed subscription `__root.tsx` mounts on every route; a real `EventSource` doesn't exist
    // under jsdom and none of these tests need it to emit anything.
    vi.stubGlobal(
        'EventSource',
        class {
            addEventListener() {}
            close() {}
        },
    );
});

afterEach(() => {
    // `apps/web/vitest.config.ts` does not set `test.globals: true`, so `@testing-library/react`'s
    // own auto-cleanup never registers — without this, each test's `render()` piles onto the
    // previous test's DOM instead of replacing it.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const ORDER = columnOrder(COLUMNS, []); // ['parking-lot', 'implementing', 'testing', 'review']
const STEP = 25; // dnd-kit's `defaultKeyboardCoordinateGetter` moves an `ArrowRight` by exactly this many px.

/** The droppable `Stack` for a column: the nearest `.mantine-Stack-root` ancestor of its stage badge. */
function columnStack(stage: string): HTMLElement {
    const badge = screen.getByText(stage);
    const stack = badge.closest('.mantine-Stack-root');
    if (!stack) throw new Error(`no droppable Stack ancestor found for column "${stage}"`);
    return stack as HTMLElement;
}

function isHighlighted(stage: string): boolean {
    return columnStack(stage).style.backgroundColor === 'var(--mantine-color-blue-light)';
}

/**
 * Non-overlapping rects for every column in `ORDER`, plus the dragged card's own rect (inside its
 * starting column) and the scroll viewport — the same four kinds of element board.drag.test.ts's
 * `rulesFor` found dnd-kit measures during a real drag. Matched by element reference (`byElement`)
 * rather than by class for the columns, because — unlike `dragBoard.ts`'s stand-in, which gives each
 * column its own `data-testid` — the real `Board.tsx`'s per-column `Stack` and its inner card-list
 * `Stack` share the same `.mantine-Stack-root` class, so a class rule alone can't tell them apart.
 */
function rectRules(cardId: string, startStage: string): RectRule[] {
    const startIndex = ORDER.indexOf(startStage);
    const cardRect = { x: startIndex * STEP + 10, y: 10, width: 5, height: 50 };
    const cardEl = screen.getByText(cardId);
    const anchor = cardEl.closest('a');
    if (!anchor) throw new Error(`could not find draggable anchor for card "${cardId}"`);
    return [
        ...ORDER.map((stage, i) => byElement(`column ${stage}`, columnStack(stage), { x: i * STEP, y: 0, width: STEP, height: 600 })),
        byElement('dragged card anchor', anchor, cardRect),
        // Matched by class, not by this one Paper instance: once picked up, `DragOverlay` mounts a
        // second `CardBody` (a `Paper` with the same class) for the pointer/keyboard-driven copy,
        // and dnd-kit's `useDragOverlayMeasuring` measures *that* Paper — its wrapper `div` has a
        // single child, and `getMeasurableNode` (node_modules/@dnd-kit/core) measures the lone
        // child instead of the wrapper itself. A rule scoped to only the original card's Paper
        // leaves the overlay's copy at jsdom's real (zero) rect, which is what board.drag.test.ts's
        // own `rulesFor` — matching by class for exactly this reason — already found necessary.
        byClass('the card body Paper', 'mantine-Paper-root', cardRect),
        byClass('the column row scroll viewport', 'mantine-ScrollArea-viewport', { x: 0, y: 0, width: ORDER.length * STEP, height: 600 }),
    ];
}

/**
 * Space picks the card up; dnd-kit's `KeyboardSensor.attach` registers the rest of its listeners
 * inside a bare `setTimeout(0)`. Takes the anchor element itself, captured once before the drag
 * starts — once picked up, `DragOverlay` portals a second copy of the same card's markup (same id
 * text) elsewhere in the tree, so re-querying `screen.getByText(cardId)` after this point is
 * ambiguous.
 */
async function pickUp(anchor: Element) {
    await act(async () => {
        fireEvent.keyDown(anchor, { code: 'Space' });
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

async function moveRight(anchor: Element) {
    await act(async () => {
        fireEvent.keyDown(anchor, { code: 'ArrowRight' });
    });
}

async function drop(anchor: Element) {
    await act(async () => {
        fireEvent.keyDown(anchor, { code: 'Space' });
    });
}

describe('dragging a card between columns (the real Board.tsx)', () => {
    it('resolves a keyboard drag onto a specific column, and calls moveCard with the dragged card\'s own id', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0007', 'implementing')]);
        const moveCard = vi.spyOn(BoardClient.prototype, 'moveCard').mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { id: '0007', title: 'card 0007', stage: 'testing', dependsOn: [], needsHuman: false, sections: {}, body: '' } as any,
        );

        renderApp(BOARD_PATH);
        await screen.findByText('card 0007');
        const anchor = screen.getByText('0007').closest('a')!;

        await withStubbedRects(rectRules('0007', 'implementing'), async () => {
            await pickUp(anchor);
            // Falsifiable before anything else: the drop already resolved to a real column — the
            // one the card started in — proving `over` isn't just stuck at `null` (two of card
            // 0046's own earlier attempt's five tests never noticed that, per plan.md).
            await waitFor(() => expect(isHighlighted('implementing')).toBe(true));
            expect(isHighlighted('testing')).toBe(false);

            await moveRight(anchor);
            // And now over the neighbour specifically, not still the start column.
            await waitFor(() => expect(isHighlighted('testing')).toBe(true));
            expect(isHighlighted('implementing')).toBe(false);

            await drop(anchor);
        });

        // The regression this card exists to fix: `handleDragEnd` used to clear `activeId`
        // synchronously before `moveCard.mutate(...)`, which (because `useMutation`'s
        // `MutationObserver` re-reads `mutationFn` from the render that commits before its own
        // internal `await onMutate?.()` resumes, not the render active when `.mutate()` was called)
        // sent the request bound to `''` instead of the card actually dragged. `toHaveBeenCalledWith`
        // pins the exact id — a request that went out with `''` fails this, not just a looser
        // "was called" check.
        await waitFor(() => expect(moveCard).toHaveBeenCalledWith('0007', { stage: 'testing' }));
        expect(moveCard).not.toHaveBeenCalledWith('', { stage: 'testing' });
    });

    it('does not call moveCard when dropped back on the column it started in, having actually resolved over that column', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0007', 'implementing')]);
        const moveCard = vi.spyOn(BoardClient.prototype, 'moveCard').mockResolvedValue({} as never);

        renderApp(BOARD_PATH);
        await screen.findByText('card 0007');
        const anchor = screen.getByText('0007').closest('a')!;

        await withStubbedRects(rectRules('0007', 'implementing'), async () => {
            await pickUp(anchor);
            // Same falsifiability point as above: the drop resolves to the starting column — this
            // is why "moveCard was not called" below means something rather than the drop having
            // simply never resolved at all.
            await waitFor(() => expect(isHighlighted('implementing')).toBe(true));
            await drop(anchor);
        });

        expect(moveCard).not.toHaveBeenCalled();
    });

    it('keeps the card in its starting column, reading as pending, while the move request is in flight', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0007', 'implementing')]);
        let resolveMove!: (value: unknown) => void;
        vi.spyOn(BoardClient.prototype, 'moveCard').mockImplementation(() => new Promise(resolve => (resolveMove = resolve)));

        renderApp(BOARD_PATH);
        await screen.findByText('card 0007');
        const anchor = screen.getByText('0007').closest('a')!;
        const paper = anchor.querySelector('.mantine-Paper-root')!;

        await withStubbedRects(rectRules('0007', 'implementing'), async () => {
            await pickUp(anchor);
            await moveRight(anchor);
            await drop(anchor);
        });

        // "The drag is animation, not state" (PROJECT.md; card 0037): still under the column it
        // started in, not moved into 'testing' just because it was dropped there.
        const implementingColumn = columnStack('implementing');
        const testingColumn = columnStack('testing');
        expect(within(implementingColumn).getByText('card 0007')).toBeTruthy();
        expect(within(testingColumn).queryByText('card 0007')).toBeNull();
        // And it reads as pending, not as if nothing happened.
        expect(paper.querySelector('.mantine-Loader-root')).not.toBeNull();

        await act(async () => {
            resolveMove({ id: '0007', title: 'card 0007', stage: 'testing', dependsOn: [], needsHuman: false, sections: {}, body: '' });
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        await waitFor(() => expect(paper.querySelector('.mantine-Loader-root')).toBeNull());
    });

    it("surfaces the API's refusal reason as a notification and leaves the card in its starting column", async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0007', 'implementing')]);
        const moveCard = vi.spyOn(BoardClient.prototype, 'moveCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: '"testing" is not a valid target for this card' } },
                new Headers(),
            ),
        );

        renderApp(BOARD_PATH);
        await screen.findByText('card 0007');
        const anchor = screen.getByText('0007').closest('a')!;

        await withStubbedRects(rectRules('0007', 'implementing'), async () => {
            await pickUp(anchor);
            await moveRight(anchor);
            await drop(anchor);
        });

        await waitFor(() => expect(moveCard).toHaveBeenCalledWith('0007', { stage: 'testing' }));
        expect(await screen.findByText('"testing" is not a valid target for this card')).toBeTruthy();
        // The generic SDK message would be a regression — the runner's own sentence must render.
        expect(screen.queryByText('400 Bad Request')).toBeNull();
        const implementingColumn = columnStack('implementing');
        const testingColumn = columnStack('testing');
        expect(within(implementingColumn).getByText('card 0007')).toBeTruthy();
        expect(within(testingColumn).queryByText('card 0007')).toBeNull();
    });
});

describe('clicking a card that is also draggable', () => {
    it('still opens the card\'s own project-scoped page', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(COLUMNS);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0007', 'implementing')]);
        // The click navigates before the destination route's own queries matter to this test —
        // mocked only so an unmocked SDK call doesn't print noise.
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue({
            id: '0007',
            title: 'card 0007',
            stage: 'implementing',
            dependsOn: [],
            needsHuman: false,
            sections: {},
            body: '',
        } as never);
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
        vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);

        const { router } = renderApp(BOARD_PATH);
        const anchor = (await screen.findByText('card 0007')).closest('a')!;
        expect(anchor.getAttribute('href')).toBe('/projects/demo/cards/0007');

        // A plain click, not a drag — no keyboard/pointer activation sequence at all. dnd-kit's
        // sensors only ever intercept a *drag* (a pointer move past the activation distance, or the
        // `Space`/`ArrowRight`/`Space` sequence the tests above drive); a bare click event is left
        // alone, so this is exactly what a user's mouse click on the card produces.
        await act(async () => {
            fireEvent.click(anchor);
        });

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo/cards/0007'));
    });
});
