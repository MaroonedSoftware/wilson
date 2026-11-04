// @vitest-environment jsdom
//
// The rules page through the real route tree: listing, adding, changing, removing and the judges' route.
import { createElement } from 'react';
import { DateTime } from 'luxon';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient, RulesClient, SettingsClient } from '@wilson/sdk';
import type { Health, Rule } from '@wilson/sdk';
import { routeTree } from '../src/routeTree.gen.js';

class FakeEventSource {
    close() {}
    addEventListener() {}
    removeEventListener() {}
}

const rule = (overrides: Partial<Rule> = {}): Rule => ({
    id: 'no-raw-sql',
    statement: 'Queries go through Kysely',
    paths: ['apps/api/src/**'],
    severity: 'blocker',
    revision: '4',
    createdAt: DateTime.utc(),
    updatedAt: DateTime.utc(),
    ...overrides,
});

const renderApp = () => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/projects/demo/rules'] }) });
    render(
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router })),
        ),
    );
};

let list: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
    // jsdom has none, and an autosizing `Textarea` listens to it.
    Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: () => {}, removeEventListener: () => {} } });
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue({ ok: true, project: 'demo' } as unknown as Health);
    vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);
    list = vi.spyOn(RulesClient.prototype, 'listRules').mockResolvedValue([rule()]);
    vi.spyOn(RulesClient.prototype, 'listRuleProposals').mockResolvedValue([]);
    vi.spyOn(SettingsClient.prototype, 'getRuleJudgeSetting').mockResolvedValue({ engine: 'cli', provider: 'anthropic', model: 'claude-sonnet-5-5' });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the rules page', () => {
    it('lists the rules and the route the judges run on', async () => {
        renderApp();

        expect(await screen.findByText('Queries go through Kysely')).toBeTruthy();
        expect(screen.getByText('apps/api/src/**')).toBeTruthy();
        expect(await screen.findByDisplayValue('claude-sonnet-5-5')).toBeTruthy();
    });

    it('says what a rule is when there are none', async () => {
        list.mockResolvedValue([]);
        renderApp();

        expect(await screen.findByText(/No rules yet/)).toBeTruthy();
    });

    it('adds a rule, splitting the globs, and reads the list again', async () => {
        const create = vi.spyOn(RulesClient.prototype, 'createRule').mockResolvedValue(rule());
        renderApp();
        await screen.findByText('Add a rule');

        fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: 'no-console' } });
        fireEvent.change(screen.getByLabelText(/^Statement/), { target: { value: 'No console.log' } });
        fireEvent.change(screen.getByLabelText(/^Paths/), { target: { value: 'src/**\ndocs/**' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() =>
            expect(create).toHaveBeenCalledWith({ id: 'no-console', statement: 'No console.log', paths: ['src/**', 'docs/**'], severity: 'blocker' }),
        );
        await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
    });

    it("shows the API's reason when a save is refused", async () => {
        vi.spyOn(RulesClient.prototype, 'createRule').mockRejectedValue(new Error('there is already a rule'));
        renderApp();
        await screen.findByText('Add a rule');

        fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: 'x' } });
        fireEvent.change(screen.getByLabelText(/^Statement/), { target: { value: 's' } });
        fireEvent.change(screen.getByLabelText(/^Paths/), { target: { value: '**' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText('Not saved')).toBeTruthy();
    });

    it('changes a rule, keeping its id', async () => {
        const update = vi.spyOn(RulesClient.prototype, 'updateRule').mockResolvedValue(rule());
        renderApp();
        fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
        await screen.findByText('Change no-raw-sql');

        fireEvent.change(screen.getByLabelText(/^Statement/), { target: { value: 'Newer words' } });
        fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);

        await waitFor(() =>
            expect(update).toHaveBeenCalledWith('no-raw-sql', { statement: 'Newer words', paths: ['apps/api/src/**'], severity: 'blocker' }),
        );
    });

    it('removes a rule', async () => {
        const remove = vi.spyOn(RulesClient.prototype, 'deleteRule').mockResolvedValue(undefined);
        renderApp();

        fireEvent.click(await screen.findByRole('button', { name: 'Remove no-raw-sql' }));

        await waitFor(() => expect(remove).toHaveBeenCalledWith('no-raw-sql', {}));
    });

    it("saves the judges' route", async () => {
        const save = vi
            .spyOn(SettingsClient.prototype, 'setRuleJudgeSetting')
            .mockResolvedValue({ engine: 'cli', provider: 'anthropic', model: 'claude-opus-5-5' });
        renderApp();
        const model = await screen.findByDisplayValue('claude-sonnet-5-5');

        fireEvent.change(model, { target: { value: 'claude-opus-5-5' } });
        fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);

        await waitFor(() => expect(save).toHaveBeenCalledWith({ engine: 'cli', provider: 'anthropic', model: 'claude-opus-5-5' }));
    });

    describe('with a proposal waiting', () => {
        const proposal = {
            id: '7',
            cardId: '0012',
            statement: 'Never log a token.',
            paths: ['src/**'],
            reason: 'It recurs.',
            expiresAt: DateTime.utc().plus({ days: 45 }),
            createdAt: DateTime.utc(),
        };

        beforeEach(() => {
            vi.spyOn(RulesClient.prototype, 'listRuleProposals').mockResolvedValue([proposal]);
        });

        it('shows it, and needs a name before it can be accepted', async () => {
            renderApp();

            expect(await screen.findByText('Never log a token.')).toBeTruthy();
            expect(screen.getByText(/It recurs/)).toBeTruthy();
            expect((screen.getByRole('button', { name: 'Make it a rule' }) as HTMLButtonElement).disabled).toBe(true);
        });

        it('accepts under the name given', async () => {
            const accept = vi.spyOn(RulesClient.prototype, 'acceptRuleProposal').mockResolvedValue(rule());
            renderApp();

            fireEvent.change(await screen.findByLabelText('Name for proposal 7'), { target: { value: 'no-token-logs' } });
            fireEvent.click(screen.getByRole('button', { name: 'Make it a rule' }));

            await waitFor(() => expect(accept).toHaveBeenCalledWith('7', { id: 'no-token-logs' }));
        });

        it('declines', async () => {
            const decline = vi.spyOn(RulesClient.prototype, 'declineRuleProposal').mockResolvedValue(undefined);
            renderApp();

            fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));

            await waitFor(() => expect(decline).toHaveBeenCalledWith('7'));
        });
    });
});
