// @vitest-environment jsdom
//
// Card 0136 ("A drag between columns cannot be asserted"): makes a drag between two board columns
// assertable, so card 0046 (parked after exhausting its testing-stage budget three times) can be
// finished. See plan.md for the full experiment log; the summary that matters here:
//
// jsdom gives every element an all-zero `getBoundingClientRect`, so dnd-kit's `rectIntersection`
// can never separate one droppable from another and `event.over` stays `null` forever — the
// `KeyboardSensor` itself activates fine under jsdom (`onDragStart`/`onDragEnd` both fire from
// `fireEvent.keyDown`), and a prototype-level stub resolves `over` correctly in a minimal
// `DndContext`. 0046's own attempt failed because it patched individual nodes with
// `Object.defineProperty`, covering only the droppable columns — recording every element dnd-kit
// actually measures during a real drag shows it also reads the dragged node's own rect and every
// scrollable/positioned ancestor between it and the droppable (`.mantine-Paper-root`,
// `.mantine-ScrollArea-viewport`). Stubbing all of those, at the `Element.prototype` level rather
// than per-node, is what finally makes a drop resolve — `tests/support/rectStub.ts` is that stub,
// `tests/support/dragBoard.ts` is a stand-in for 0046's committed `Board.tsx` (out of scope for
// this card — see that file's own comment for why a stand-in and not the real component).
//
// jsdom sufficed once every measured element was covered, so `vitest` browser mode (the plan's
// fallback) was not needed: no new dependency, no browser binary, and this file still runs under
// the testing stage's `pnpm exec vitest run` allowlist exactly as every other test here does.
//
// Getting a drop to resolve at all surfaced a second, independent problem, not about jsdom: 0046's
// committed `Board.tsx` calls `setActiveId(null)` and then `moveCard.mutate(targetStage, ...)` in
// the same `handleDragEnd`, with `useMoveCard(activeId ?? '')` bound to that same `activeId`.
// `@tanstack/react-query`'s `useMutation` keeps one `MutationObserver` across renders and re-reads
// its `mutationFn` from whichever render most recently committed — not from the render active when
// `.mutate()` was called — because `execute()` is `async` and yields (at its own internal
// `await onMutate?.()`) before ever calling `mutationFn`. Clearing `activeId` synchronously forces
// exactly that re-render, with `activeId: null`, inside that window, so the request that actually
// goes out is bound to `''`, not the card being moved — reproduced in isolation, independent of any
// of the drag/jsdom machinery above, in "the id a moveCard request carries" below. `dragBoard.ts`'s
// stand-in does not repeat this — it defers clearing `activeId` to the mutation's own `onSettled`,
// the same moment `pendingId` already clears — but 0046's real `Board.tsx` still has it; that file
// is out of scope for this card (see dragBoard.ts's own comment), so this is reported, not fixed,
// here.
import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { CardSummary } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { DragBoard } from './support/dragBoard.js';
import { byClass, byTestId, withStubbedRects, type RectRule } from './support/rectStub.js';

const e = createElement;

/** Mantine's `ScrollArea` measures itself with `ResizeObserver` on mount; jsdom has none. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const card = (id: string, stage: string): CardSummary => ({ id, title: `card ${id}`, stage, dependsOn: [], needsHuman: false });

const COLUMNS = ['implementing', 'testing', 'review'];

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // jsdom does not implement matchMedia; MantineProvider reads it on mount regardless of what
    // this test renders (same stub settings.test.ts and card-detail.actions.test.ts both need).
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
});

afterEach(() => {
    // `apps/web/vitest.config.ts` does not set `test.globals: true`, so `@testing-library/react`'s
    // own auto-cleanup never registers — without this, each test's `render()` piles onto the
    // previous test's DOM instead of replacing it.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function renderBoard(grouped: Map<string, CardSummary[]>) {
    const queryClient = new QueryClient();
    render(
        e(
            MantineProvider,
            null,
            e(
                QueryClientProvider,
                { client: queryClient },
                e(Notifications, { key: 'notifications' }),
                e(DragBoard, { key: 'board', order: COLUMNS, grouped }),
            ),
        ),
    );
}

/**
 * The rect rule set point 4 and 5 of the plan found necessary: every one of the four kinds of
 * element dnd-kit measures during a real drag — the dragged node, its droppable column, the
 * `Paper` it renders inside, and the `ScrollArea` viewport that scrolls the whole column row — gets
 * a real, non-zero rect. Columns get distinct, non-overlapping rects (left to right, in `COLUMNS`
 * order) so `rectIntersection`/the keyboard coordinate getter can actually tell them apart; the
 * dragged card's own rect sits inside its starting column so an immediate drop resolves `over` to
 * that same column rather than nothing.
 *
 * The column width (`STEP`) is deliberately tied to dnd-kit's own `defaultKeyboardCoordinateGetter`
 * (node_modules/@dnd-kit/core): every `ArrowRight` moves the dragged rect by exactly 25px, not to
 * "the next droppable" — there is no such jump. This was the harness's own second false start:
 * one `ArrowRight` against columns sized like real 260px-wide board columns lands nowhere near the
 * neighbour, so `over` resolves back to the starting column and looks exactly like the
 * still-broken state points 4-5 describe, even once every element in the tree has a stubbed rect.
 * Sizing each column to one 25px step (and keeping the dragged card's rect a safe margin inside
 * its own column) makes each `ArrowRight` cross exactly one column boundary, deterministically.
 */
const STEP = 25;

function rulesFor(startingStage: string): RectRule[] {
    const startIndex = COLUMNS.indexOf(startingStage);
    const columnRects = COLUMNS.map((stage, i) => byTestId(`column-${stage}`, { x: i * STEP, y: 0, width: STEP, height: 600 }));
    const cardRect = { x: startIndex * STEP + 10, y: 10, width: 5, height: 50 };
    return [
        ...columnRects,
        byTestId('card-0007', cardRect),
        byClass('the card body Paper', 'mantine-Paper-root', cardRect),
        byClass('the column row scroll viewport', 'mantine-ScrollArea-viewport', { x: 0, y: 0, width: COLUMNS.length * STEP, height: 600 }),
    ];
}

/**
 * Drives a keyboard drag exactly as the plan's point 1 found reliable under jsdom: `Space` to
 * pick up, `ArrowRight` (repeated) to move across columns, `Space` to drop. No synthetic pointer
 * geometry, no real mouse events — `KeyboardSensor` activates from plain `fireEvent.keyDown`.
 *
 * dnd-kit's own `KeyboardSensor.attach` (node_modules/@dnd-kit/core, `attach()`) registers the
 * listener that handles every key *after* the activating `Space` — the one `ArrowRight`/`Space`
 * need — inside a bare `setTimeout(() => this.listeners.add(...))`, not synchronously. Firing all
 * three keydowns back to back in the same tick (as a first pass at this harness did) means the
 * second and third never reach a listener that exists yet, and `onDragEnd` silently never fires at
 * all — not a jsdom geometry problem, a sequencing one. A real browser has the same `setTimeout(0)`
 * in its path; it simply never lines up with a script driving three keydowns in one synchronous
 * burst, which is exactly what a test (unlike a human) does by default. Yielding once past that
 * timeout before continuing is the fix, independent of anything about rects.
 */
async function dragRight(steps: number) {
    const el = screen.getByTestId('card-0007');
    await act(async () => {
        fireEvent.keyDown(el, { code: 'Space' });
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    for (let i = 0; i < steps; i++) {
        await act(async () => {
            fireEvent.keyDown(el, { code: 'ArrowRight' });
        });
    }
    await act(async () => {
        fireEvent.keyDown(el, { code: 'Space' });
    });
}

describe('dragging a card between columns', () => {
    it('resolves the drop and calls moveCard with the column actually released over', async () => {
        const moveCard = vi.spyOn(wilson.board, 'moveCard').mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { id: '0007', title: 'card 0007', stage: 'testing', dependsOn: [], needsHuman: false, sections: {}, body: '' } as any,
        );
        renderBoard(
            new Map([
                ['implementing', [card('0007', 'implementing')]],
                ['testing', []],
                ['review', []],
            ]),
        );

        await withStubbedRects(rulesFor('implementing'), () => dragRight(1));

        // This is the assertion the plan's acceptance criteria name directly: it fails if
        // `onDragEnd` never receives an `over` (moveCard would simply never be called), not just if
        // the wrong stage were passed.
        await waitFor(() => expect(moveCard).toHaveBeenCalledWith('0007', { stage: 'testing' }));
        expect(screen.getByTestId('last-over-stage').textContent).toBe('testing');
    });

    it('moves across more than one column, landing on the one actually released over — not just the neighbour', async () => {
        const moveCard = vi.spyOn(wilson.board, 'moveCard').mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { id: '0007', title: 'card 0007', stage: 'review', dependsOn: [], needsHuman: false, sections: {}, body: '' } as any,
        );
        renderBoard(
            new Map([
                ['implementing', [card('0007', 'implementing')]],
                ['testing', []],
                ['review', []],
            ]),
        );

        await withStubbedRects(rulesFor('implementing'), () => dragRight(2));

        await waitFor(() => expect(moveCard).toHaveBeenCalledWith('0007', { stage: 'review' }));
        expect(screen.getByTestId('last-over-stage').textContent).toBe('review');
    });

    it('does not call moveCard when dropped back on its own column', async () => {
        const moveCard = vi.spyOn(wilson.board, 'moveCard').mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {} as any,
        );
        renderBoard(
            new Map([
                ['implementing', [card('0007', 'implementing')]],
                ['testing', []],
                ['review', []],
            ]),
        );

        await withStubbedRects(rulesFor('implementing'), () => dragRight(0));

        // The constraint this test file exists to satisfy: a negative assertion is worthless if
        // `over` never resolved at all (two of 0046's five preserved tests did exactly that). This
        // reads `last-over-stage` back to prove the drop *did* resolve — to the card's own starting
        // column, which is why `moveCard` correctly was not called — rather than trusting silence.
        // The companion tests above are the other half of that proof: the same harness, driven one
        // `ArrowRight` further, does call `moveCard` — so this test failing to move is a fact about
        // the drop, not about the harness being unable to produce one.
        expect(screen.getByTestId('last-over-stage').textContent).toBe('implementing');
        expect(moveCard).not.toHaveBeenCalled();
    });

    it("renders the server's refusal reason and leaves the card in its original column", async () => {
        const moveCard = vi
            .spyOn(wilson.board, 'moveCard')
            .mockRejectedValue(
                new SdkError(
                    400,
                    'Bad Request',
                    { statusCode: 400, message: 'Bad Request', details: { reason: '"review" is not a valid target for this card' } },
                    new Headers(),
                ),
            );
        renderBoard(
            new Map([
                ['implementing', [card('0007', 'implementing')]],
                ['testing', []],
                ['review', []],
            ]),
        );

        await withStubbedRects(rulesFor('implementing'), () => dragRight(2));

        await waitFor(() => expect(moveCard).toHaveBeenCalledWith('0007', { stage: 'review' }));
        expect(await screen.findByText('"review" is not a valid target for this card')).toBeTruthy();
        // The generic SDK message would be a regression — the runner's own sentence must render.
        expect(screen.queryByText('400 Bad Request')).toBeNull();
        // The card stays put: still rendered inside its original column, not the one it was
        // (refused) dropped on.
        const implementingColumn = screen.getByTestId('column-implementing');
        expect(within(implementingColumn).getByTestId('card-0007')).toBeTruthy();
        const reviewColumn = screen.getByTestId('column-review');
        expect(within(reviewColumn).queryByTestId('card-0007')).toBeNull();
    });
});

/**
 * Isolates the second finding above from all of the drag/jsdom machinery: a plain `useMutation`
 * bound to a piece of state, exercised through the exact "clear the state, then call `.mutate()`"
 * shape `handleDragEnd` uses. No `@dnd-kit/core`, no rects, no `DragBoard` — just proof that the
 * ordering itself is what decides which `id` a request carries, so this reads as a fact about
 * `@tanstack/react-query` + React (relevant to 0046's `Board.tsx`, but not specific to it), not an
 * artifact of this file's own drag harness.
 */
describe('the id a moveCard-shaped request actually carries', () => {
    function useMoveLike(id: string, onCall: (id: string, stage: string) => void) {
        const queryClient = useQueryClient();
        return useMutation({
            mutationFn: async (stage: string) => {
                await Promise.resolve(); // a real `mutationFn` is at least this asynchronous.
                onCall(id, stage);
            },
            onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['x'] }),
        });
    }

    it("is stale when the bound state is cleared in the same handler that calls mutate — 0046's own ordering", async () => {
        const onCall = vi.fn();
        function NaiveWidget() {
            const [activeId, setActiveId] = useState<string | null>('0007');
            const mutation = useMoveLike(activeId ?? '', onCall);
            return e('button', {
                onClick: () => {
                    setActiveId(null); // 0046's `Board.tsx`: `setActiveId(null)` immediately, same handler.
                    mutation.mutate('testing');
                },
            });
        }
        const queryClient = new QueryClient();
        render(e(QueryClientProvider, { client: queryClient }, e(NaiveWidget)));
        await act(async () => {
            fireEvent.click(screen.getByRole('button'));
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        // Not `'0007'` — the request this reproduces really does carry the wrong id. This is the
        // proof for the claim in this file's header comment and in dragBoard.ts: it is not a typo
        // to be fixed by re-ordering the two lines (0046's plausible next guess) — moving
        // `mutation.mutate(...)` before `setActiveId(null)` fails exactly the same way, because
        // the mutation's actual invocation is deferred past the re-render regardless of source
        // order.
        expect(onCall).toHaveBeenCalledWith('', 'testing');
    });

    it('carries the right id when the bound state is only cleared once the mutation settles', async () => {
        const onCall = vi.fn();
        function FixedWidget() {
            const [activeId, setActiveId] = useState<string | null>('0007');
            const mutation = useMoveLike(activeId ?? '', onCall);
            return e('button', {
                onClick: () => mutation.mutate('testing', { onSettled: () => setActiveId(null) }),
            });
        }
        const queryClient = new QueryClient();
        render(e(QueryClientProvider, { client: queryClient }, e(FixedWidget)));
        await act(async () => {
            fireEvent.click(screen.getByRole('button'));
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        expect(onCall).toHaveBeenCalledWith('0007', 'testing');
    });
});
