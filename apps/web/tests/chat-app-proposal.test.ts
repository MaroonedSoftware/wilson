// @vitest-environment jsdom
import { DateTime } from 'luxon';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from '@wilson/sdk';
import type { ChatPendingAction } from '@wilson/sdk';
import { ChatAppProposalCard } from '#src/components/ChatAppProposalCard.js';
import { PROPOSED_APP_OPERATION, proposedApp } from '#src/lib/apps.js';
import { wilson } from '#src/lib/sdk.js';
import { WilsonSdkProvider } from '#src/lib/sdk-context.js';

/**
 * Reviewing an app the chat proposed (`ChatAppProposalCard`). What these pin: the source is there to
 * read as text, nothing is granted unless the person ticks it, and what the chat asked for changes
 * neither.
 */

const HTML = '<script>wilson.listCards()</script><img src=x onerror="window.ran = true">';

const action = (extra: Partial<ChatPendingAction> = {}): ChatPendingAction => ({
    id: '31',
    threadId: '7',
    operation: PROPOSED_APP_OPERATION,
    arguments: { slug: 'open-cards', name: 'Open cards', description: 'What is open', html: HTML, requestedGrants: ['board.read', 'stats.read'] },
    summary: 'Install a new app, Open cards.',
    status: 'pending',
    expiresAt: DateTime.now().plus({ minutes: 10 }),
    createdAt: DateTime.now(),
    ...extra,
});

const renderCard = (proposal: ChatPendingAction) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        createElement(
            MantineProvider,
            null,
            createElement(
                QueryClientProvider,
                { client },
                createElement(WilsonSdkProvider, {
                    client: wilson,
                    children: createElement(ChatAppProposalCard, { action: proposal, app: proposedApp(proposal)! }),
                }),
            ),
        ),
    );
};

const decideSpy = () => vi.spyOn(ChatClient.prototype, 'decideAChatAction').mockImplementation(async () => action({ status: 'done' }));

/** Mantine's `ScrollArea` measures itself with `ResizeObserver`. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
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

describe('proposedApp', () => {
    it('leaves any other action to the ordinary card', () => {
        expect(proposedApp(action({ operation: 'move_card' }))).toBeUndefined();
    });

    it('leaves arguments it cannot read to the ordinary card, whose confirm the API refuses', () => {
        expect(proposedApp(action({ arguments: { slug: 'open-cards' } }))).toBeUndefined();
    });

    it('drops a requested grant this build does not know', () => {
        const app = proposedApp(action({ arguments: { slug: 'a', name: 'A', html: 'x', requestedGrants: ['board.read', 'board.write'] } }));

        expect(app?.requestedGrants).toEqual(['board.read']);
    });
});

describe('ChatAppProposalCard', () => {
    it('shows the source as text and does not render it', () => {
        const { container } = renderCard(action());

        expect(screen.getByLabelText('App source').textContent).toBe(HTML);
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('script')).toBeNull();
    });

    it('starts with nothing ticked, whatever the chat asked for, and says what it asked for', () => {
        renderCard(action());

        const group = within(screen.getByRole('group', { name: 'Proposed app' }));
        for (const box of group.getAllByRole('checkbox')) expect((box as HTMLInputElement).checked).toBe(false);
        expect(group.getByRole('checkbox', { name: /Board \(the chat asks for this\)/ })).toBeTruthy();
        expect(group.getByRole('checkbox', { name: /^Activity/ })).toBeTruthy();
    });

    it('sends an empty list when nothing was ticked', async () => {
        const decide = decideSpy();
        renderCard(action());

        fireEvent.click(screen.getByRole('button', { name: 'Install' }));

        await waitFor(() => expect(decide).toHaveBeenCalledWith('31', { decision: 'confirm', grants: [] }));
    });

    it('sends only what was ticked', async () => {
        const decide = decideSpy();
        renderCard(action());

        fireEvent.click(screen.getByRole('checkbox', { name: /^Activity/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Install' }));

        await waitFor(() => expect(decide).toHaveBeenCalledWith('31', { decision: 'confirm', grants: ['activity.read'] }));
    });

    it('declines without sending any grants', async () => {
        const decide = decideSpy();
        renderCard(action());

        fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

        await waitFor(() => expect(decide).toHaveBeenCalledWith('31', { decision: 'decline' }));
    });

    it('offers no choice once expired, and says so', () => {
        renderCard(action({ expiresAt: DateTime.now().minus({ minutes: 1 }) }));

        expect(screen.getByText('expired')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
        expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('says what the app was installed with', () => {
        renderCard(action({ status: 'done', result: { slug: 'open-cards', name: 'Open cards', grants: ['board.read'] } }));

        expect(screen.getByText(/It can read: Board\./)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    });

    it('says why it failed', () => {
        renderCard(action({ status: 'failed', error: 'an app named "open-cards" is already installed' }));

        expect(screen.getByText('an app named "open-cards" is already installed')).toBeTruthy();
    });
});
