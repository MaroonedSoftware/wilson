// @vitest-environment jsdom
//
// Card 0138's `DraftPane.tsx` replaces card 0137's read-only placeholder in the `planning` pane
// with the session's live draft: an editable `Textarea` fed by `usePlanDraft`, and an `Approve…`
// control gated behind `ApproveDialog`'s diff and explicit confirmation. This file renders
// `DraftPane` directly — it takes only a `card` prop and has no router dependency — with `wilson`'s
// SDK calls mocked, covering: the fetched draft landing in the editable text, the approve control's
// disabled states, the diff shown before any write, a refusal left on screen rather than lost, a
// successful save, and the "whose edit wins" collision the component's own doc comment describes.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { CardDetail } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { DraftPane } from '#src/components/DraftPane.js';

/** `ScrollArea` and `Textarea autosize` (Mantine) both measure themselves on mount — jsdom has
 * neither `ResizeObserver` nor the Font Loading API. Same stand-ins planning-session.test.ts uses. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const card = (overrides: Partial<CardDetail> = {}): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage: 'planning',
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the current plan body',
    ...overrides,
});

function renderDraftPane(cardDetail: CardDetail, queryClient = new QueryClient()) {
    render(
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: queryClient }, createElement(DraftPane, { card: cardDetail })),
        ),
    );
    return { queryClient };
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });
    // jsdom does not implement matchMedia; MantineProvider reads it on mount. Same stand-in
    // planning-session.test.ts uses.
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
});

describe('DraftPane', () => {
    it("loads the session's draft through getAPlanDraft and shows it in the editable textarea, not the read-only card body", async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: '## a fresh draft the agent wrote' });

        renderDraftPane(card());

        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('## a fresh draft the agent wrote'));
        expect(wilson.board.getAPlanDraft).toHaveBeenCalledWith('0007');
    });

    it('lets a person edit the draft directly, and the edit is what stays on screen', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'original draft' });

        renderDraftPane(card());
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('original draft'));

        fireEvent.change(textarea, { target: { value: 'the operator rewrote this' } });

        expect(textarea.value).toBe('the operator rewrote this');
        expect(screen.getByText('unsaved')).toBeTruthy();
    });

    it('disables Approve until the draft actually differs from the current body', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'the current plan body' });

        renderDraftPane(card({ body: 'the current plan body' }));
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('the current plan body'));

        const approve = screen.getByRole('button', { name: 'Approve…' });
        expect((approve as HTMLButtonElement).disabled).toBe(true);

        fireEvent.change(textarea, { target: { value: 'the current plan body, edited' } });
        expect((approve as HTMLButtonElement).disabled).toBe(false);
    });

    it('disables Approve when the draft is emptied out to whitespace, without re-implementing the six-section rule', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'some draft' });

        renderDraftPane(card());
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('some draft'));

        fireEvent.change(textarea, { target: { value: '   ' } });

        expect((screen.getByRole('button', { name: 'Approve…' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('does not client-side validate the six PLAN_SECTIONS headings — Approve stays enabled for any non-empty, changed draft', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'the current plan body' });

        renderDraftPane(card({ body: 'the current plan body' }));
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('the current plan body'));

        // No "## Goal", no "## Acceptance criteria" — a draft that `PlanService.save` would refuse.
        // The client only cares that it changed and isn't blank; the server is the sole validator.
        fireEvent.change(textarea, { target: { value: 'not a plan at all' } });

        expect((screen.getByRole('button', { name: 'Approve…' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('opens a diff of the draft against the current body before anything is written, and writes nothing until confirmed', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'line one\nline two' });
        const saveAPlanDraft = vi.spyOn(wilson.board, 'saveAPlanDraft');

        renderDraftPane(card({ body: 'line one\nline two' }));
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('line one\nline two'));

        fireEvent.change(textarea, { target: { value: 'line one\nline three' } });
        fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));

        expect(await screen.findByText('Write this as a new version of 0007?')).toBeTruthy();
        expect(screen.getByText('- line two')).toBeTruthy();
        expect(screen.getByText('+ line three')).toBeTruthy();
        expect(saveAPlanDraft).not.toHaveBeenCalled();
    });

    it('cancelling the dialog writes nothing and keeps the edit on screen', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'original' });
        const saveAPlanDraft = vi.spyOn(wilson.board, 'saveAPlanDraft');

        renderDraftPane(card({ body: 'original' }));
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('original'));
        fireEvent.change(textarea, { target: { value: 'edited but not approved' } });

        fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
        await screen.findByText('Write this as a new version of 0007?');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByText('Write this as a new version of 0007?')).toBeNull());
        expect(saveAPlanDraft).not.toHaveBeenCalled();
        expect(textarea.value).toBe('edited but not approved');
    });

    it('confirming calls saveAPlanDraft with exactly the edited text', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'original' });
        const saveAPlanDraft = vi.spyOn(wilson.board, 'saveAPlanDraft').mockResolvedValue(card({ body: 'edited and approved' }));

        renderDraftPane(card({ body: 'original' }));
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('original'));
        fireEvent.change(textarea, { target: { value: 'edited and approved' } });

        fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
        await screen.findByText('Write this as a new version of 0007?');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Write this version' }));
        });

        expect(saveAPlanDraft).toHaveBeenCalledWith('0007', { body: 'edited and approved' });
        // A successful save closes the confirmation dialog.
        await waitFor(() => expect(screen.queryByText('Write this as a new version of 0007?')).toBeNull());
    });

    it("shows the server's own refusal sentence in the dialog, and leaves the draft on screen unlost", async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'original' });
        vi.spyOn(wilson.board, 'saveAPlanDraft').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'plan is missing "Acceptance criteria"' } },
                new Headers(),
            ),
        );

        renderDraftPane(card({ body: 'original' }));
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('original'));
        fireEvent.change(textarea, { target: { value: 'a draft the server refuses' } });

        fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
        await screen.findByText('Write this as a new version of 0007?');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Write this version' }));
        });

        expect(await screen.findByText('plan is missing "Acceptance criteria"')).toBeTruthy();
        // Not a generic message, and not lost: the dialog stays open with the same draft.
        expect(screen.queryByText('Save failed')).toBeNull();
        expect(screen.getByText('Write this as a new version of 0007?')).toBeTruthy();
        expect(textarea.value).toBe('a draft the server refuses');
    });

    it("does not overwrite a person's in-progress edit when a poll disagrees, and offers to load the agent's version instead", async () => {
        const getAPlanDraft = vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'draft v1' });
        const { queryClient } = renderDraftPane(card());
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('draft v1'));

        // The person starts editing — the draft is now "dirty" against the last-accepted baseline.
        fireEvent.change(textarea, { target: { value: 'the person is mid-edit' } });
        expect(screen.queryByText('The agent wrote a new draft while you were editing')).toBeNull();

        // A poll lands with the agent's own newer write, disagreeing with both the baseline and the
        // person's edit. Simulated by writing straight into the query cache `usePlanDraft` reads
        // from, the same effect a real `refetchInterval` tick would have.
        act(() => {
            queryClient.setQueryData(['plan-draft', '0007'], { body: 'draft v2, from the agent' });
        });

        expect(await screen.findByText('The agent wrote a new draft while you were editing')).toBeTruthy();
        // The person's typing is kept, not silently replaced.
        expect(textarea.value).toBe('the person is mid-edit');

        fireEvent.click(screen.getByRole('button', { name: "Use the agent's version instead" }));

        await waitFor(() => expect(textarea.value).toBe('draft v2, from the agent'));
        expect(screen.queryByText('The agent wrote a new draft while you were editing')).toBeNull();
        expect(getAPlanDraft).toHaveBeenCalled();
    });

    it('syncs an incoming poll straight into the textarea when the draft has not been touched — no banner needed', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'draft v1' });
        const { queryClient } = renderDraftPane(card());
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('draft v1'));

        act(() => {
            queryClient.setQueryData(['plan-draft', '0007'], { body: 'draft v2, still unedited' });
        });

        await waitFor(() => expect(textarea.value).toBe('draft v2, still unedited'));
        expect(screen.queryByText('The agent wrote a new draft while you were editing')).toBeNull();
    });

    it('switches to a rendered Markdown preview of the current text without losing the edit underneath', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: '**bold plan text**' });

        renderDraftPane(card());
        const textarea = (await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('**bold plan text**'));

        fireEvent.click(screen.getByRole('radio', { name: 'Preview' }));

        expect(await screen.findByText('bold plan text')).toBeTruthy();
        expect(screen.queryByRole('textbox', { name: 'Draft' })).toBeNull();

        fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
        expect((await screen.findByRole('textbox', { name: 'Draft' })) as HTMLTextAreaElement).toHaveProperty('value', '**bold plan text**');
    });

    it('shows the load failure inline when the draft cannot be fetched', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockRejectedValue(
            new SdkError(500, 'Internal Server Error', { statusCode: 500, message: 'draft store unreachable' }, new Headers()),
        );
        // Retries off: react-query's default backoff (~1s, 2s, 4s) would outlast findByText's
        // default wait for no reason this test cares about — the client behaviour under test is
        // rendering `error`, not how many attempts it takes to give up.
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        renderDraftPane(card(), queryClient);

        expect(await screen.findByText('Could not load the draft')).toBeTruthy();
        expect(await screen.findByText('draft store unreachable')).toBeTruthy();
    });
});
