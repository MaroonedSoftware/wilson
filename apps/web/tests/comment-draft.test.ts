// @vitest-environment jsdom
//
// Card 0147's `CommentableDraft.tsx` is new: a layer over the rendered draft (`Markdown`,
// unmodified) that lets a person select a passage, comment on it, see it anchored through
// [[0145]]'s `locateAnchor`, and see it marked outdated once a revision removes the quote. This
// file renders `CommentableDraft` directly — the same way `draft-pane.test.ts` renders `DraftPane`
// directly — covering: capturing a selection into the anchor `useAddPlanComment` actually sends,
// a located comment reachable from its highlight, an anchor [[0145]] cannot locate staying visible
// as outdated, a comment that survives a reword because its quote is unchanged, resolving, and a
// refusal rendering the server's own sentence without losing what was typed.
//
// jsdom implements neither `Range.prototype.getClientRects` at all nor real layout, so
// `rectsRelativeTo` (`CommentableDraft.tsx`) would throw the moment it tried to place a highlight
// for a *located* comment. `stubRangeClientRects` below installs a fake implementation for the
// tests that exercise that path — the same kind of prototype-level stand-in `support/rectStub.ts`
// installs for `getBoundingClientRect` so dnd-kit's own geometry math has something to read under
// jsdom. Tests that only ever reach an *outdated* comment need no stub: `locateAnchor` reporting
// outdated is exactly the branch that skips placing a highlight at all.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError, type PlanComment } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { captureAnchor } from '#src/lib/anchor.js';
import { CommentableDraft } from '#src/components/CommentableDraft.js';

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

/** Installs a fake `Range.prototype.getClientRects` for the lifetime of the callback, restoring
 * whatever was there before (jsdom has no implementation at all — see this file's header). Every
 * non-collapsed range reports the same single rectangle; `CommentableDraft` never needs more than
 * one distinguishable rect to prove a highlight was placed. */
async function withStubbedRangeRects<T>(rect: { top: number; left: number; width: number; height: number }, fn: () => T | Promise<T>): Promise<T> {
    const fakeRect = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON() {
            return this;
        },
    } as DOMRect;
    const real = Range.prototype.getClientRects;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Range.prototype as any).getClientRects = function (this: Range) {
        return this.collapsed ? [] : [fakeRect];
    };
    try {
        return await fn();
    } finally {
        Range.prototype.getClientRects = real;
    }
}

const comment = (overrides: Partial<PlanComment> = {}): PlanComment => ({
    id: 'c1',
    quote: 'brown fox',
    prefix: 'The quick ',
    suffix: ' jumps over the lazy dog.',
    text: 'nice catch',
    resolved: false,
    createdAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
});

function renderDraft(text: string, cardId = '0007', queryClient = new QueryClient()) {
    const utils = render(
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: queryClient }, createElement(CommentableDraft, { cardId, text })),
        ),
    );
    return { queryClient, ...utils };
}

/** Selects `[start, end)` of `text` inside the one text node under `p` — the paragraph
 * `CommentableDraft` wraps its rendered `Markdown` output in — and fires the `mouseup`
 * `CommentableDraft` listens for, exactly as a real drag-then-release would leave the DOM. */
function selectAndRelease(p: Element, start: number, end: number) {
    const textNode = p.firstChild!;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.setBaseAndExtent(textNode, start, textNode, end);
    fireEvent.mouseUp(p);
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });
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
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.getSelection()?.removeAllRanges();
});

const TEXT = 'The quick brown fox jumps over the lazy dog.';

// Every test in this block makes a real, non-collapsed selection, which drives
// `CommentableDraft`'s `pendingRect` — placing the compose popover needs a rect for that
// selection just as much as placing a found comment's highlight does, so this block needs the
// same `Range.prototype.getClientRects` stand-in described in this file's header.
const RECT = { top: 10, left: 20, width: 60, height: 14 };

describe('CommentableDraft — capturing a selection', () => {
    it('offers a comment box on the passage just selected, anchored at the selection rect', () =>
        withStubbedRangeRects(RECT, async () => {
            vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([]);
            const { container } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('p')).toBeTruthy());
            const p = container.querySelector('p')!;

            selectAndRelease(p, TEXT.indexOf('brown fox'), TEXT.indexOf('brown fox') + 'brown fox'.length);

            expect(await screen.findByLabelText('Comment')).toBeTruthy();
        }));

    it("submitting sends exactly the anchor captureAnchor would build for that span, plus the typed text", () =>
        withStubbedRangeRects(RECT, async () => {
            vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([]);
            const addAPlanComment = vi.spyOn(wilson.board, 'addAPlanComment').mockResolvedValue(comment());
            const { container } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('p')).toBeTruthy());
            const p = container.querySelector('p')!;
            const start = TEXT.indexOf('brown fox');
            const end = start + 'brown fox'.length;

            selectAndRelease(p, start, end);
            const textarea = await screen.findByLabelText('Comment');
            fireEvent.change(textarea, { target: { value: 'nice catch' } });
            fireEvent.click(await screen.findByRole('button', { name: 'Comment', hidden: true }));

            const expectedAnchor = captureAnchor(TEXT, start, end);
            await waitFor(() =>
                expect(addAPlanComment).toHaveBeenCalledWith('0007', { ...expectedAnchor, text: 'nice catch' }),
            );
            expect(expectedAnchor.quote).toBe('brown fox');
        }));

    it('the Comment button stays disabled until something is actually typed', () =>
        withStubbedRangeRects(RECT, async () => {
            vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([]);
            const { container } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('p')).toBeTruthy());
            const p = container.querySelector('p')!;

            selectAndRelease(p, TEXT.indexOf('brown fox'), TEXT.indexOf('brown fox') + 'brown fox'.length);
            await screen.findByLabelText('Comment');

            const button = (await screen.findByRole('button', { name: 'Comment', hidden: true })) as HTMLButtonElement;
            expect(button.disabled).toBe(true);
        }));

    it('cancelling closes the compose box and sends nothing', () =>
        withStubbedRangeRects(RECT, async () => {
            vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([]);
            const addAPlanComment = vi.spyOn(wilson.board, 'addAPlanComment');
            const { container } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('p')).toBeTruthy());
            const p = container.querySelector('p')!;

            selectAndRelease(p, TEXT.indexOf('brown fox'), TEXT.indexOf('brown fox') + 'brown fox'.length);
            await screen.findByLabelText('Comment');
            fireEvent.click(await screen.findByRole('button', { name: 'Cancel', hidden: true }));

            await waitFor(() => expect(screen.queryByLabelText('Comment')).toBeNull());
            expect(addAPlanComment).not.toHaveBeenCalled();
        }));

    it("a refused create shows the server's own sentence and keeps what was typed on screen", () =>
        withStubbedRangeRects(RECT, async () => {
            vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([]);
            vi.spyOn(wilson.board, 'addAPlanComment').mockRejectedValue(
                new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'a comment already covers this passage' } }, new Headers()),
            );
            const { container } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('p')).toBeTruthy());
            const p = container.querySelector('p')!;

            selectAndRelease(p, TEXT.indexOf('brown fox'), TEXT.indexOf('brown fox') + 'brown fox'.length);
            const textarea = (await screen.findByLabelText('Comment')) as HTMLTextAreaElement;
            fireEvent.change(textarea, { target: { value: 'my careful note' } });
            fireEvent.click(await screen.findByRole('button', { name: 'Comment', hidden: true }));

            expect(await screen.findByText('a comment already covers this passage')).toBeTruthy();
            expect((screen.getByLabelText('Comment') as HTMLTextAreaElement).value).toBe('my careful note');
        }));
});

describe('CommentableDraft — anchored comments', () => {
    it("shows a comment whose quote is unambiguous as anchored, reachable by hovering its highlight — not in the outdated list", async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment()]);

        await withStubbedRangeRects(RECT, async () => {
            const { container } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('mark')).toBeTruthy());

            fireEvent.mouseEnter(container.querySelector('mark')!);

            expect(await screen.findByText('nice catch')).toBeTruthy();
            expect(screen.getByText('“brown fox”')).toBeTruthy();
            expect(screen.queryByText('Outdated comments')).toBeNull();
        });
    });

    it('keeps a comment anchored across a revision that reworded the surroundings but kept the quote intact', async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment()]);

        await withStubbedRangeRects(RECT, async () => {
            const { container, rerender } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('mark')).toBeTruthy());

            const reworded = 'A quick brown fox jumps clean over one very lazy dog.';
            const queryClient = new QueryClient();
            queryClient.setQueryData(['plan-comments', '0007'], [comment()]);
            rerender(
                createElement(
                    MantineProvider,
                    null,
                    createElement(
                        QueryClientProvider,
                        { client: queryClient },
                        createElement(CommentableDraft, { cardId: '0007', text: reworded }),
                    ),
                ),
            );

            await waitFor(() => expect(container.querySelector('mark')).toBeTruthy());
            expect(screen.queryByText('Outdated comments')).toBeNull();
        });
    });

    it('resolving from the anchored popover calls resolveAPlanComment with the comment id', async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment()]);
        const resolveAPlanComment = vi.spyOn(wilson.board, 'resolveAPlanComment').mockResolvedValue(comment({ resolved: true }));

        await withStubbedRangeRects(RECT, async () => {
            const { container } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('mark')).toBeTruthy());
            fireEvent.mouseEnter(container.querySelector('mark')!);
            await screen.findByText('nice catch');

            fireEvent.click(await screen.findByRole('button', { name: 'Resolve', hidden: true }));

            await waitFor(() => expect(resolveAPlanComment).toHaveBeenCalledWith('0007', 'c1'));
        });
    });
});

describe('CommentableDraft — outdated comments', () => {
    it('a comment whose quote no longer appears renders as outdated, visible, and attached to no passage', async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment({ quote: 'a phrase the draft no longer has' })]);
        const { container } = renderDraft(TEXT);

        expect(await screen.findByText('Outdated comments')).toBeTruthy();
        expect(screen.getByText('outdated')).toBeTruthy();
        expect(screen.getByText('“a phrase the draft no longer has”')).toBeTruthy();
        // Not dropped, and not attached to any nearby passage — no highlight was placed for it.
        expect(container.querySelector('mark')).toBeNull();
    });

    it('renders as outdated once a revision removes the quote a comment used to be anchored to', () =>
        withStubbedRangeRects(RECT, async () => {
            const withRemoved = comment({ quote: 'brown fox' });
            vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([withRemoved]);

            // Starts found — "brown fox" is right there in TEXT — so the highlight path (needing
            // the Range-rect stub) runs before the revision below ever removes the quote.
            const { container, rerender } = renderDraft(TEXT);
            await waitFor(() => expect(container.querySelector('mark')).toBeTruthy());
            expect(screen.queryByText('Outdated comments')).toBeNull();

            const queryClient = new QueryClient();
            queryClient.setQueryData(['plan-comments', '0007'], [withRemoved]);
            rerender(
                createElement(
                    MantineProvider,
                    null,
                    createElement(
                        QueryClientProvider,
                        { client: queryClient },
                        createElement(CommentableDraft, { cardId: '0007', text: 'The fox is gone from this sentence entirely.' }),
                    ),
                ),
            );

            expect(await screen.findByText('Outdated comments')).toBeTruthy();
        }));

    it('a resolved comment stays visible, marked resolved, with no Resolve control left to press', async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([
            comment({ quote: 'a phrase the draft no longer has', resolved: true }),
        ]);
        renderDraft(TEXT);

        await screen.findByText('Outdated comments');
        expect(screen.getByText('resolved')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    });

    it("a refused resolve shows the server's own sentence next to the comment", async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment({ quote: 'a phrase the draft no longer has' })]);
        vi.spyOn(wilson.board, 'resolveAPlanComment').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'comment was already resolved' } }, new Headers()),
        );
        renderDraft(TEXT);
        await screen.findByText('Outdated comments');

        fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));

        expect(await screen.findByText('comment was already resolved')).toBeTruthy();
    });

    it("shows the load failure inline when the comment list can't be fetched", async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockRejectedValue(
            new SdkError(500, 'Internal Server Error', { statusCode: 500, message: 'comment store unreachable' }, new Headers()),
        );
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        renderDraft(TEXT, '0007', queryClient);

        expect(await screen.findByText('comment store unreachable')).toBeTruthy();
    });
});
