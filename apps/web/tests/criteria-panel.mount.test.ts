import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0245. `CardDetailView` (`CardDetail.tsx`) now parses the plan's `acceptance-criteria` section
// with the web's own `acceptanceCriteria` (`lib/card.ts`) and mounts a `CriteriaPanel` between the
// `Files in scope` block and the plan region whenever the plan has any criteria at all. None of this
// wiring existed before this card — before it, a card's acceptance criteria were nowhere on the page.
// This file renders the real app router (the same approach `card-detail.actions.test.ts` takes) so
// the mount condition, the section key, and the review-status lookup are all exercised as actually
// wired together, not just each piece in isolation.
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient } from '@wilson/sdk';
import type { BoardColumns, CardDetail, CardEvent } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const CARD_PATH = '/projects/demo/cards/0007';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const card = (sections: Record<string, string>): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage: 'testing',
    dependsOn: [],
    needsHuman: false,
    sections,
    body: 'the plan',
});

/** Same stand-in `card-detail.actions.test.ts` uses: the root layout's `useCardFeed` needs an `EventSource`. */
class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

/** Same stand-in `card-detail.actions.test.ts` uses: Mantine's `ScrollArea` measures itself via `ResizeObserver`. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient();
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    return { router };
}

beforeEach(() => {
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.stubGlobal('EventSource', FakeEventSource);
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
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    notifications.clean();
});

describe('acceptance criteria on the card page', () => {
    it('shows nothing when the plan has no Acceptance criteria section', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card({ 'files-in-scope': '- apps/web/**' }));
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(screen.queryByText('Acceptance criteria')).toBeNull();
    });

    it("lists the plan's criteria by ID before any review has run, with no status badge", async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(
            card({ 'files-in-scope': '- apps/web/**', 'acceptance-criteria': '- AC1: Widget renders.\n- AC2: Widget updates.' }),
        );
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('Acceptance criteria')).toBeTruthy();
        expect(screen.getByText('AC1')).toBeTruthy();
        expect(screen.getByText('Widget renders.')).toBeTruthy();
        expect(screen.getByText('AC2')).toBeTruthy();
        expect(screen.getByText('Widget updates.')).toBeTruthy();
        expect(screen.queryByText('met')).toBeNull();
    });

    it('shows the status the latest review gave each criterion once one has run', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(
            card({ 'files-in-scope': '- apps/web/**', 'acceptance-criteria': '- AC1: Widget renders.\n- AC2: Widget updates.' }),
        );
        const reviewEvent: CardEvent = {
            id: 'e1',
            type: 'stage.failed',
            stage: 'review',
            payload: {
                result: {
                    criteria: [
                        { id: 'AC1', status: 'met' },
                        { id: 'AC2', status: 'unmet' },
                    ],
                },
            },
            createdAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
        };
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([reviewEvent]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        expect(await screen.findByText('met')).toBeTruthy();
        expect(screen.getByText('unmet')).toBeTruthy();
    });

    it('mounts between the Files in scope block and the plan region, not the other way around', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(
            card({
                'files-in-scope': '- apps/web/**',
                'acceptance-criteria': '- AC1: Widget renders.',
                tasks: 'Build the widget.',
            }),
        );
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        const scopeHeading = await screen.findByText('Files in scope');
        const criteriaHeading = await screen.findByText('Acceptance criteria');
        // Bit 4 of `compareDocumentPosition` (`DOCUMENT_POSITION_FOLLOWING`) is set when the argument
        // node comes after the reference node — i.e. the criteria panel is genuinely mounted after
        // the files-in-scope block, not merely present somewhere on the page.
        await act(async () => {});
        expect(scopeHeading.compareDocumentPosition(criteriaHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
