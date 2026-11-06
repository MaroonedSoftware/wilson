import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0010: a card's images on its page — `CardAttachments.tsx`'s section on `CardDetail.tsx`, over
// `lib/mutations.ts`'s `useAttachImage`/`useRemoveAttachment`. The same real-app-render approach
// `card-context.test.ts` takes: the SDK's calls mocked, the route tree rendered for real, so the
// no-optimistic-rendering rule, the bytes-through-the-SDK rule and refusal-surfacing are exercised as
// actually wired up.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, ContextClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardAttachment, CardDetail } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const CARD_PATH = '/projects/demo/cards/0007';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const card: CardDetail = {
    id: '0007',
    title: 'Do the thing',
    stage: 'testing',
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
};

const attachment = (overrides: Partial<CardAttachment> = {}): CardAttachment => ({
    id: '1',
    filename: 'login.png',
    contentType: 'image/png',
    byteSize: 2048,
    contentHash: 'abc123',
    addedBy: 'human',
    createdAt: DateTime.fromISO('2026-11-01T12:00:00.000Z'),
    ...overrides,
});

const LOGIN = attachment();
const MOCKUP = attachment({ id: '2', filename: 'mockup.jpg', contentType: 'image/jpeg', byteSize: 4096 });

// Same jsdom gaps `card-context.test.ts` stubs — the root layout and app shell pull these in
// regardless of what this file's own tests are about.
class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string) {
    // No retries: the context list is refused on purpose below, and should settle at once.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    return { router };
}

let fetchAnAttachment: ReturnType<typeof vi.spyOn>;
let objectUrls: string[];

beforeEach(() => {
    vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card);
    vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    // Refused, so the context section shows an error rather than a second "Nothing attached." or a
    // second "Remove" button for these tests to tell apart from the images section's own.
    vi.spyOn(ContextClient.prototype, 'listCardContext').mockRejectedValue(new Error('not under test'));
    fetchAnAttachment = vi.spyOn(ContextClient.prototype, 'fetchAnAttachment').mockImplementation(async (_id: string, attachmentId: string) => ({
        contentType: 'image/png' as const,
        data: new Blob([`bytes of ${attachmentId}`], { type: 'image/png' }),
        headers: { xContentTypeOptions: 'nosniff', contentSecurityPolicy: "default-src 'none'" },
    }));

    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();
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
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });
    // One more jsdom gap: it implements neither, and the thumbnails show their bytes from one.
    objectUrls = [];
    Object.defineProperty(URL, 'createObjectURL', {
        value: vi.fn(() => {
            const url = `blob:test/${objectUrls.length + 1}`;
            objectUrls.push(url);
            return url;
        }),
        configurable: true,
        writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    notifications.clean();
});

const refusal = (status: number, reason: string) =>
    new SdkError(status, 'Bad Request', { statusCode: status, message: 'Bad Request', details: { reason } }, new Headers());

const pick = async (file: File) => {
    const input = screen.getByTestId('attach-image-input') as HTMLInputElement;
    await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
    });
};

describe('the images section', () => {
    it('renders a thumbnail and filename per attachment, fetching each one’s bytes once and showing them from an object URL', async () => {
        vi.spyOn(ContextClient.prototype, 'listCardAttachments').mockResolvedValue([LOGIN, MOCKUP]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const login = (await screen.findByAltText('login.png')) as HTMLImageElement;
        const mockup = (await screen.findByAltText('mockup.jpg')) as HTMLImageElement;
        expect(screen.getByText('login.png')).toBeTruthy();
        expect(screen.getByText('mockup.jpg')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Images' })).toBeTruthy();

        expect(fetchAnAttachment).toHaveBeenCalledTimes(2);
        expect(fetchAnAttachment).toHaveBeenCalledWith('0007', '1');
        expect(fetchAnAttachment).toHaveBeenCalledWith('0007', '2');
        expect(objectUrls).toContain(login.getAttribute('src'));
        expect(objectUrls).toContain(mockup.getAttribute('src'));
    });

    it('opens the image full size in a modal titled with its filename', async () => {
        vi.spyOn(ContextClient.prototype, 'listCardAttachments').mockResolvedValue([LOGIN]);

        renderApp(CARD_PATH);
        const thumbnail = (await screen.findByAltText('login.png')) as HTMLImageElement;

        fireEvent.click(screen.getByRole('button', { name: 'Open login.png full size' }));

        const dialog = await screen.findByRole('dialog', { name: 'login.png' });
        expect((within(dialog).getByAltText('login.png') as HTMLImageElement).getAttribute('src')).toBe(thumbnail.getAttribute('src'));
    });

    it('shows an empty state for a card with no images and requests no bytes', async () => {
        vi.spyOn(ContextClient.prototype, 'listCardAttachments').mockResolvedValue([]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('Nothing attached.')).toBeTruthy();
        expect(fetchAnAttachment).not.toHaveBeenCalled();
    });

    it('uploads a picked file as FormData and shows it only once the list refetches', async () => {
        const listCardAttachments = vi.spyOn(ContextClient.prototype, 'listCardAttachments').mockResolvedValue([]);
        let resolveUpload: ((a: CardAttachment) => void) | undefined;
        const attachAnImageToACard = vi.spyOn(ContextClient.prototype, 'attachAnImageToACard').mockImplementation(
            () =>
                new Promise<CardAttachment>(resolve => {
                    resolveUpload = resolve;
                }),
        );

        renderApp(CARD_PATH);
        expect(await screen.findByText('Nothing attached.')).toBeTruthy();

        const file = new File(['png bytes'], 'login.png', { type: 'image/png' });
        await pick(file);

        expect(attachAnImageToACard).toHaveBeenCalledTimes(1);
        const [id, body] = attachAnImageToACard.mock.calls[0]!;
        expect(id).toBe('0007');
        expect(body).toBeInstanceOf(FormData);
        expect((body as FormData).get('file')).toBe(file);
        // In flight: nothing appears before the server answers.
        expect(screen.getByText('Nothing attached.')).toBeTruthy();

        const calls = listCardAttachments.mock.calls.length;
        listCardAttachments.mockResolvedValue([LOGIN]);
        await act(async () => {
            resolveUpload?.(LOGIN);
        });

        expect(await screen.findByText('login.png')).toBeTruthy();
        expect(listCardAttachments.mock.calls.length).toBeGreaterThan(calls);
        expect(screen.queryByText('Nothing attached.')).toBeNull();
    });

    it("shows the API's own refusal reason, leaves the list as it was, and leaves the picker usable", async () => {
        vi.spyOn(ContextClient.prototype, 'listCardAttachments').mockResolvedValue([]);
        const attachAnImageToACard = vi
            .spyOn(ContextClient.prototype, 'attachAnImageToACard')
            .mockRejectedValueOnce(refusal(400, 'the file is not a PNG, JPEG, WebP or GIF image'))
            .mockRejectedValueOnce(refusal(413, 'a card holds at most 20 MB of images'));

        renderApp(CARD_PATH);
        expect(await screen.findByText('Nothing attached.')).toBeTruthy();

        await pick(new File(['not an image'], 'notes.png', { type: 'image/png' }));

        expect((await screen.findAllByText('the file is not a PNG, JPEG, WebP or GIF image')).length).toBeGreaterThan(0);
        expect(screen.getByText('Nothing attached.')).toBeTruthy();

        // Still usable without a reload: a second pick goes out and its own refusal shows.
        expect((screen.getByRole('button', { name: 'Add image' }) as HTMLButtonElement).disabled).toBe(false);
        await pick(new File(['big'], 'huge.png', { type: 'image/png' }));
        expect(attachAnImageToACard).toHaveBeenCalledTimes(2);
        expect((await screen.findAllByText('a card holds at most 20 MB of images')).length).toBeGreaterThan(0);
    });

    it('removes an image only after a confirmation, then refetches the list', async () => {
        const listCardAttachments = vi.spyOn(ContextClient.prototype, 'listCardAttachments').mockResolvedValue([LOGIN, MOCKUP]);
        const removeAnAttachment = vi.spyOn(ContextClient.prototype, 'removeAnAttachment').mockResolvedValue(undefined);

        renderApp(CARD_PATH);
        await screen.findByAltText('login.png');

        const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
        expect(removeButtons).toHaveLength(2);
        fireEvent.click(removeButtons[0]!);

        const dialog = await screen.findByRole('dialog', { name: 'Remove this image?' });
        expect(within(dialog).getByText('login.png')).toBeTruthy();
        expect(removeAnAttachment).not.toHaveBeenCalled();

        // Dismissing calls nothing.
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove this image?' })).toBeNull());
        expect(removeAnAttachment).not.toHaveBeenCalled();

        fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
        const again = await screen.findByRole('dialog', { name: 'Remove this image?' });
        listCardAttachments.mockResolvedValue([MOCKUP]);
        await act(async () => {
            fireEvent.click(within(again).getByRole('button', { name: 'Remove' }));
        });

        expect(removeAnAttachment).toHaveBeenCalledWith('0007', '1');
        await waitFor(() => expect(screen.queryByText('login.png')).toBeNull());
        expect(screen.getByText('mockup.jpg')).toBeTruthy();
    });
});
