// @vitest-environment jsdom
//
// Card 0037's `lib/mutations.ts` is new: `useMoveCard` and `useStartCard`, each a thin
// `useMutation` over the SDK's `moveCard`/`startCard`. This file covers them directly, in
// isolation from the components that call them (card-detail.actions.test.ts covers those) —
// the invalidate-only-on-success rule and the refusal-reason plumbing are both properties of
// these hooks themselves, not of any one place they're wired up.
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { useMoveCard, useStartCard } from '#src/lib/mutations.js';

// `notifications.show` is Mantine's own emitter — it works without a mounted `<Notifications />`,
// but stubbing it here lets a test assert exactly what a refusal is shown as, without also having
// to render the notifications viewport just to read the DOM back.
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
import { notifications } from '@mantine/notifications';

afterEach(() => {
    vi.restoreAllMocks();
});

const withClient = (queryClient: QueryClient) => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    return wrapper;
};

describe('useMoveCard', () => {
    it('invalidates the cards list and the card itself on success — nothing else, and no direct write', async () => {
        vi.spyOn(wilson.board, 'moveCard').mockResolvedValue({
            id: '0007',
            title: 'x',
            stage: 'implementing',
            dependsOn: [],
            needsHuman: false,
            sections: {},
            body: '',
        });
        const queryClient = new QueryClient();
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
        const setQueryData = vi.spyOn(queryClient, 'setQueryData');

        const { result } = renderHook(() => useMoveCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync('implementing');
        });

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['cards'] });
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['card', '0007'] });
        // The runner is the sole writer (PROJECT.md, Architecture) — a successful move must only
        // ever trigger a re-fetch, never poke the new stage into the cache directly.
        expect(setQueryData).not.toHaveBeenCalled();
    });

    it("shows the API's own refusal reason as a notification, not the generic SDK message", async () => {
        vi.spyOn(wilson.board, 'moveCard').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'not a valid target' } }, new Headers()),
        );
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useMoveCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate('merged');
        });

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Could not move the card', message: 'not a valid target' }),
            ),
        );
    });

    it('falls back to the body message when a refusal carries no details.reason', async () => {
        vi.spyOn(wilson.board, 'moveCard').mockRejectedValue(
            new SdkError(500, 'Internal Server Error', { statusCode: 500, message: 'something broke' }, new Headers()),
        );
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useMoveCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate('implementing');
        });

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'something broke' })),
        );
    });
});

describe('useStartCard', () => {
    it('invalidates the cards list and the card itself on success, with no direct write', async () => {
        vi.spyOn(wilson.board, 'startCard').mockResolvedValue({
            id: '0007',
            title: 'x',
            stage: 'testing',
            dependsOn: [],
            needsHuman: false,
            sections: {},
            body: '',
        });
        const queryClient = new QueryClient();
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
        const setQueryData = vi.spyOn(queryClient, 'setQueryData');

        const { result } = renderHook(() => useStartCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync();
        });

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['cards'] });
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['card', '0007'] });
        expect(setQueryData).not.toHaveBeenCalled();
    });

    it('shows the reason a job already carrying the card refuses it', async () => {
        vi.spyOn(wilson.board, 'startCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'card 0007 is already carried by job job-42' } },
                new Headers(),
            ),
        );
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useStartCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate();
        });

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Could not enqueue the card', message: 'card 0007 is already carried by job job-42' }),
            ),
        );
    });

    it('shows the reason whyNotDispatchable refuses it', async () => {
        vi.spyOn(wilson.board, 'startCard').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'plan is missing "Acceptance criteria"' } },
                new Headers(),
            ),
        );
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useStartCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate();
        });

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'plan is missing "Acceptance criteria"' })),
        );
    });
});
