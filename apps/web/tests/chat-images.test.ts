// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from '@wilson/sdk';
import { AssistantMessage, UserMessage } from '#src/components/ChatMessages.js';
import { wilson } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';

const PIXEL = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

const attachment = (id: string, filename: string): ChatAttachment => ({
    id,
    filename,
    contentType: 'image/png',
    byteSize: 4,
    contentHash: `hash-${id}`,
    createdAt: DateTime.now(),
});

/** Through the providers the app puts above a chat, and a router since an answer's `Markdown` reads its params. */
const show = (element: ReactNode) => {
    const router = createRouter({
        routeTree: createRootRoute({ component: () => element }),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        createElement(
            MantineProvider,
            null,
            createElement(
                QueryClientProvider,
                { client },
                createElement(WilsonSdkProvider, { client: wilson, children: createElement(RouterProvider, { router: router as never }) }),
            ),
        ),
    );
};

let created = 0;
beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
    vi.stubGlobal('scrollTo', vi.fn());
    // jsdom implements neither; fresh stand-ins each test so calls can be asserted on.
    Object.assign(URL, { createObjectURL: vi.fn(() => `blob:test/${++created}`), revokeObjectURL: vi.fn() });
    vi.spyOn(wilson.chat, 'fetchAChatImage').mockResolvedValue({
        contentType: 'image/png',
        data: PIXEL,
        headers: { xContentTypeOptions: 'nosniff', contentSecurityPolicy: "default-src 'none'" },
    });
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('UserMessage', () => {
    it('draws each attachment, with its filename as alt text, and no count caption', async () => {
        const { container } = show(
            createElement(UserMessage, {
                text: '',
                threadId: '7',
                attachments: [attachment('1', 'first.png'), attachment('2', 'second.png')],
            }),
        );
        expect(await screen.findByAltText('first.png')).toBeTruthy();
        expect(await screen.findByAltText('second.png')).toBeTruthy();
        expect(container.querySelectorAll('img')).toHaveLength(2);
        expect(screen.queryByText('2 images')).toBeNull();
        expect(wilson.chat.fetchAChatImage).toHaveBeenCalledWith('7', '1');
        expect(wilson.chat.fetchAChatImage).toHaveBeenCalledWith('7', '2');
    });

    it('draws nothing for a message with no attachments', async () => {
        const { container } = show(createElement(UserMessage, { text: 'hello', threadId: '7' }));
        await screen.findByText('hello');
        expect(container.querySelector('img')).toBeNull();
        expect(screen.queryByText(/image/)).toBeNull();
    });

    it('draws no attachment while the thread is not known yet', async () => {
        const { container } = show(createElement(UserMessage, { text: 'hello', threadId: undefined, attachments: [attachment('1', 'first.png')] }));
        await screen.findByText('hello');
        expect(container.querySelector('img')).toBeNull();
        expect(wilson.chat.fetchAChatImage).not.toHaveBeenCalled();
    });
});

describe('AssistantMessage', () => {
    it('draws an attachment its markdown embeds once, not twice', async () => {
        const { container } = show(
            createElement(AssistantMessage, {
                text: 'Here it is: ![the chart](/api/chat/threads/7/attachments/3)',
                operations: [],
                threadId: '7',
                attachments: [attachment('3', 'chart.png')],
            }),
        );
        expect(await screen.findByAltText('the chart')).toBeTruthy();
        expect(container.querySelectorAll('img')).toHaveLength(1);
        expect(screen.queryByAltText('chart.png')).toBeNull();
    });

    it('draws an attachment its text never mentions below the answer', async () => {
        const { container } = show(
            createElement(AssistantMessage, {
                text: 'I made a chart.',
                operations: [],
                threadId: '7',
                attachments: [attachment('3', 'chart.png')],
            }),
        );
        expect(await screen.findByAltText('chart.png')).toBeTruthy();
        expect(container.querySelectorAll('img')).toHaveLength(1);
    });
});

describe('InlineImage', () => {
    it('revokes the object URL it made when it unmounts', async () => {
        const { unmount } = show(createElement(UserMessage, { text: '', threadId: '7', attachments: [attachment('1', 'first.png')] }));
        const image = await screen.findByAltText('first.png');
        const made = vi.mocked(URL.createObjectURL).mock.results.at(-1)?.value as string;
        expect(image.getAttribute('src')).toBe(made);
        unmount();
        await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith(made));
    });

    it('builds the object URL from the SDK Blob, whatever contentType claims', async () => {
        const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' });
        vi.mocked(wilson.chat.fetchAChatImage).mockResolvedValue({
            contentType: 'image/png',
            data: svg,
            headers: { xContentTypeOptions: 'nosniff', contentSecurityPolicy: "default-src 'none'" },
        });
        show(createElement(UserMessage, { text: '', threadId: '7', attachments: [attachment('1', 'drawing.svg')] }));
        const image = await screen.findByAltText('drawing.svg');
        expect(URL.createObjectURL).toHaveBeenCalledWith(svg);
        expect(image.getAttribute('src')).toMatch(/^blob:/);
    });

    it.each([
        ['a click', (image: HTMLElement) => fireEvent.click(image)],
        ['Enter', (image: HTMLElement) => fireEvent.keyDown(image, { key: 'Enter' })],
    ])('opens the enlarged image on %s', async (_label, open) => {
        show(createElement(UserMessage, { text: '', threadId: '7', attachments: [attachment('1', 'first.png')] }));
        const image = await screen.findByAltText('first.png');
        expect(screen.queryByRole('dialog')).toBeNull();
        open(image);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByAltText('first.png')).toBeTruthy();
    });
});
