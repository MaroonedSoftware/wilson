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
import { SdkError, type CardDetail, type CardSummary, type PlanComment } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import {
    useAddPlanComment,
    useCreateCard,
    useMoveCard,
    useRepositionCard,
    useResolvePlanComment,
    useSaveAPlanDraft,
    useStartCard,
} from '#src/lib/mutations.js';

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
        // Card 0155 deleted the top-level board and card routes: the only board and card queries
        // left in the app are a project route's own `['project', project, ...]`-prefixed ones
        // (`projects.$project.index.tsx`, `projects.$project.cards.$cardId.tsx`), so this seeds one
        // of each — plus an unrelated key — and asserts on the actual cache effect rather than the
        // literal arguments `invalidateQueries` is called with, which is now a `predicate` function,
        // not an exact key (this file's own header, and `mutations.ts`'s doc comment on `useMoveCard`).
        queryClient.setQueryData(['project', 'demo', 'cards'], []);
        queryClient.setQueryData(['project', 'demo', 'card', '0007'], {});
        queryClient.setQueryData(['unrelated'], {});
        const setQueryData = vi.spyOn(queryClient, 'setQueryData');

        const { result } = renderHook(() => useMoveCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync('implementing');
        });

        expect(queryClient.getQueryState(['project', 'demo', 'cards'])?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(['project', 'demo', 'card', '0007'])?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(['unrelated'])?.isInvalidated).toBeFalsy();
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

describe('useRepositionCard', () => {
    const card = (id: string, position?: number): CardSummary => ({
        id,
        title: `card ${id}`,
        stage: 'parking-lot',
        dependsOn: [],
        needsHuman: false,
        position,
    });

    it("writes the caller's already-reordered cards straight into the ['cards'] cache before the request even resolves — the one optimistic write on the board", async () => {
        const original = [card('0001', 0), card('0002', 1)];
        const optimisticCards = [card('0002', 0), card('0001', 1)];
        let resolveReposition!: (value: unknown) => void;
        vi.spyOn(wilson.board, 'repositionCard').mockImplementation(() => new Promise(resolve => (resolveReposition = resolve)));
        const queryClient = new QueryClient();
        queryClient.setQueryData(['cards'], original);

        const { result } = renderHook(() => useRepositionCard(), { wrapper: withClient(queryClient) });
        act(() => {
            result.current.mutate({ id: '0001', beforeId: '0002', optimisticCards });
        });

        await waitFor(() => expect(queryClient.getQueryData(['cards'])).toEqual(optimisticCards));
        resolveReposition({});
    });

    it('sends only id, beforeId and afterId — not the optimistic cards array — to the SDK', async () => {
        const repositionCard = vi.spyOn(wilson.board, 'repositionCard').mockResolvedValue({} as never);
        const queryClient = new QueryClient();
        queryClient.setQueryData(['cards'], [card('0001', 0), card('0002', 1)]);

        const { result } = renderHook(() => useRepositionCard(), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync({ id: '0001', beforeId: '0002', afterId: undefined, optimisticCards: [card('0002', 0), card('0001', 1)] });
        });

        expect(repositionCard).toHaveBeenCalledWith('0001', { beforeId: '0002', afterId: undefined });
    });

    it('rolls back to the order before the drag and shows the refusal reason when the API rejects it', async () => {
        const original = [card('0001', 0), card('0002', 1)];
        const optimisticCards = [card('0002', 0), card('0001', 1)];
        vi.spyOn(wilson.board, 'repositionCard').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'someone else moved this card first' } }, new Headers()),
        );
        const queryClient = new QueryClient();
        queryClient.setQueryData(['cards'], original);

        const { result } = renderHook(() => useRepositionCard(), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate({ id: '0001', beforeId: '0002', optimisticCards });
        });

        await waitFor(() => expect(queryClient.getQueryData(['cards'])).toEqual(original));
        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Could not reorder the card', message: 'someone else moved this card first' }),
            ),
        );
    });

    it('invalidates the cards list on success, to reconcile with the server\'s own order', async () => {
        vi.spyOn(wilson.board, 'repositionCard').mockResolvedValue({} as never);
        const queryClient = new QueryClient();
        // Card 0155: only a project-scoped board (`['project', project, 'cards']`) is reachable now
        // — asserting the actual cache effect (invalidated) rather than the literal `invalidateQueries`
        // arguments, which is a `predicate` function since this card, not an exact `['cards']` key.
        queryClient.setQueryData(['project', 'demo', 'cards'], [card('0001', 0), card('0002', 1)]);
        queryClient.setQueryData(['unrelated'], {});

        const { result } = renderHook(() => useRepositionCard(), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync({ id: '0001', beforeId: '0002', optimisticCards: [card('0002', 0), card('0001', 1)] });
        });

        expect(queryClient.getQueryState(['project', 'demo', 'cards'])?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(['unrelated'])?.isInvalidated).toBeFalsy();
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
        // Card 0155: the only board and card queries reachable now carry a `['project', project, ...]`
        // prefix — same reasoning as `useMoveCard`'s test above, and the same `predicate` (not exact
        // key) that `invalidateQueries` is actually called with since this card.
        queryClient.setQueryData(['project', 'demo', 'cards'], []);
        queryClient.setQueryData(['project', 'demo', 'card', '0007'], {});
        queryClient.setQueryData(['unrelated'], {});
        const setQueryData = vi.spyOn(queryClient, 'setQueryData');

        const { result } = renderHook(() => useStartCard('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync();
        });

        expect(queryClient.getQueryState(['project', 'demo', 'cards'])?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(['project', 'demo', 'card', '0007'])?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(['unrelated'])?.isInvalidated).toBeFalsy();
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

describe('useSaveAPlanDraft', () => {
    const savedCard: CardSummary & { body: string; sections: Record<string, string> } = {
        id: '0007',
        title: 'Do the thing',
        stage: 'planning',
        dependsOn: [],
        needsHuman: false,
        sections: {},
        body: 'the approved draft',
    };

    it('sends the body to plan/save and writes the response straight into the card cache — not an invalidate', async () => {
        const saveAPlanDraft = vi.spyOn(wilson.board, 'saveAPlanDraft').mockResolvedValue(savedCard);
        const queryClient = new QueryClient();
        // Card 0155: a card reached through a `/projects/$project/*` route keeps its own copy at
        // `['project', project, 'card', id]` (`mutations.ts`'s doc comment on this hook) — writing
        // through `setQueriesData({ predicate: matchesCard }, result)` rather than the literal
        // `['card', id]` key this test used to assert on. `setQueriesData` only ever touches queries
        // already in the cache, so this file seeds one project-scoped copy (with stale data) plus an
        // unrelated key, and asserts on the actual written value rather than the literal arguments
        // `setQueryData` is called with.
        queryClient.setQueryData(['project', 'demo', 'card', '0007'], { ...savedCard, body: 'stale' });
        queryClient.setQueryData(['unrelated'], {});
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

        const { result } = renderHook(() => useSaveAPlanDraft('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync('the approved draft');
        });

        expect(saveAPlanDraft).toHaveBeenCalledWith('0007', { body: 'the approved draft' });
        // Card [[0138]]'s own contract (`mutations.ts`'s doc comment): the card's new version reaches
        // the screen the moment the write lands, straight from the response, not from a refetch a
        // caller would otherwise have to wait on.
        expect(queryClient.getQueryData(['project', 'demo', 'card', '0007'])).toEqual(savedCard);
        expect(queryClient.getQueryData(['unrelated'])).toEqual({});
        expect(invalidateQueries).not.toHaveBeenCalled();
    });

    it("does not show a notification on refusal — DraftPane reads the error itself so the draft is never lost to a toast", async () => {
        vi.spyOn(wilson.board, 'saveAPlanDraft').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'plan is missing "Acceptance criteria"' } },
                new Headers(),
            ),
        );
        const queryClient = new QueryClient();
        vi.mocked(notifications.show).mockClear();

        const { result } = renderHook(() => useSaveAPlanDraft('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate('an incomplete draft');
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(notifications.show).not.toHaveBeenCalled();
    });

    it("exposes the server's own refusal reason via the mutation's error, unlike a generic failure message", async () => {
        vi.spyOn(wilson.board, 'saveAPlanDraft').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'plan is missing "Acceptance criteria"' } },
                new Headers(),
            ),
        );
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useSaveAPlanDraft('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate('an incomplete draft');
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error).toBeInstanceOf(SdkError);
        expect((result.current.error as SdkError).body).toMatchObject({ details: { reason: 'plan is missing "Acceptance criteria"' } });
    });
});

describe('useCreateCard', () => {
    const created: CardDetail = {
        id: '0143',
        title: 'A new thought',
        stage: 'parking-lot',
        dependsOn: [],
        needsHuman: false,
        sections: {},
        body: '## Note\n\nsomething worth capturing',
    };

    it('sends the title, stage and body straight through to the SDK and resolves with the created card', async () => {
        const createCard = vi.spyOn(wilson.board, 'createCard').mockResolvedValue(created);
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useCreateCard(), { wrapper: withClient(queryClient) });
        let resolved: CardDetail | undefined;
        await act(async () => {
            resolved = await result.current.mutateAsync({ title: 'A new thought', stage: 'parking-lot', body: '## Note\n\nsomething worth capturing' });
        });

        expect(createCard).toHaveBeenCalledWith({ title: 'A new thought', stage: 'parking-lot', body: '## Note\n\nsomething worth capturing' });
        expect(resolved).toEqual(created);
    });

    it('does not invalidate the cards list on success — the feed already covers that, per this hook\'s own doc comment', async () => {
        vi.spyOn(wilson.board, 'createCard').mockResolvedValue(created);
        const queryClient = new QueryClient();
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
        const setQueryData = vi.spyOn(queryClient, 'setQueryData');

        const { result } = renderHook(() => useCreateCard(), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync({ title: 'A new thought', stage: 'parking-lot', body: 'x' });
        });

        expect(invalidateQueries).not.toHaveBeenCalled();
        expect(setQueryData).not.toHaveBeenCalled();
    });

    it("shows the API's own refusal reason as a notification titled 'Could not create card'", async () => {
        vi.spyOn(wilson.board, 'createCard').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'title is required' } }, new Headers()),
        );
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useCreateCard(), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate({ title: '', stage: 'parking-lot', body: 'x' });
        });

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Could not create card', message: 'title is required' }),
            ),
        );
    });
});

describe('useAddPlanComment', () => {
    const added: PlanComment = {
        id: 'c1',
        quote: 'brown fox',
        prefix: 'The quick ',
        suffix: ' jumps over',
        text: 'nice catch',
        resolved: false,
        createdAt: '2026-08-27T00:00:00.000Z',
    };

    it('sends the anchor and text straight through to addAPlanComment and resolves with the created comment', async () => {
        const addAPlanComment = vi.spyOn(wilson.board, 'addAPlanComment').mockResolvedValue(added);
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useAddPlanComment('0007'), { wrapper: withClient(queryClient) });
        let resolved: PlanComment | undefined;
        await act(async () => {
            resolved = await result.current.mutateAsync({ quote: 'brown fox', prefix: 'The quick ', suffix: ' jumps over', text: 'nice catch' });
        });

        expect(addAPlanComment).toHaveBeenCalledWith('0007', {
            quote: 'brown fox',
            prefix: 'The quick ',
            suffix: ' jumps over',
            text: 'nice catch',
        });
        expect(resolved).toEqual(added);
    });

    it("invalidates this card's ['plan-comments', id] query on success, the key usePlanComments reads", async () => {
        vi.spyOn(wilson.board, 'addAPlanComment').mockResolvedValue(added);
        const queryClient = new QueryClient();
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

        const { result } = renderHook(() => useAddPlanComment('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync({ quote: 'brown fox', prefix: '', suffix: '', text: 'nice catch' });
        });

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['plan-comments', '0007'] });
    });

    it("does not show a notification on refusal — CommentableDraft reads the error itself so what was typed is never lost to a toast", async () => {
        vi.spyOn(wilson.board, 'addAPlanComment').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'quote is empty' } }, new Headers()),
        );
        const queryClient = new QueryClient();
        vi.mocked(notifications.show).mockClear();

        const { result } = renderHook(() => useAddPlanComment('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate({ quote: '', prefix: '', suffix: '', text: 'nice catch' });
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(notifications.show).not.toHaveBeenCalled();
    });

    it("exposes the server's own refusal reason via the mutation's error", async () => {
        vi.spyOn(wilson.board, 'addAPlanComment').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'quote is empty' } }, new Headers()),
        );
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useAddPlanComment('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate({ quote: '', prefix: '', suffix: '', text: 'nice catch' });
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect((result.current.error as SdkError).body).toMatchObject({ details: { reason: 'quote is empty' } });
    });
});

describe('useResolvePlanComment', () => {
    const resolved: PlanComment = {
        id: 'c1',
        quote: 'brown fox',
        prefix: '',
        suffix: '',
        text: 'nice catch',
        resolved: true,
        createdAt: '2026-08-27T00:00:00.000Z',
    };

    it('resolves the comment by id through resolveAPlanComment', async () => {
        const resolveAPlanComment = vi.spyOn(wilson.board, 'resolveAPlanComment').mockResolvedValue(resolved);
        const queryClient = new QueryClient();

        const { result } = renderHook(() => useResolvePlanComment('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync('c1');
        });

        expect(resolveAPlanComment).toHaveBeenCalledWith('0007', 'c1');
    });

    it("invalidates this card's ['plan-comments', id] query on success rather than patching the cache by hand", async () => {
        vi.spyOn(wilson.board, 'resolveAPlanComment').mockResolvedValue(resolved);
        const queryClient = new QueryClient();
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
        const setQueryData = vi.spyOn(queryClient, 'setQueryData');

        const { result } = renderHook(() => useResolvePlanComment('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            await result.current.mutateAsync('c1');
        });

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['plan-comments', '0007'] });
        expect(setQueryData).not.toHaveBeenCalled();
    });

    it("does not show a notification on refusal — the same server sentence renders inline next to the comment instead", async () => {
        vi.spyOn(wilson.board, 'resolveAPlanComment').mockRejectedValue(
            new SdkError(400, 'Bad Request', { statusCode: 400, message: 'Bad Request', details: { reason: 'comment already resolved' } }, new Headers()),
        );
        const queryClient = new QueryClient();
        vi.mocked(notifications.show).mockClear();

        const { result } = renderHook(() => useResolvePlanComment('0007'), { wrapper: withClient(queryClient) });
        await act(async () => {
            result.current.mutate('c1');
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(notifications.show).not.toHaveBeenCalled();
        expect((result.current.error as SdkError).body).toMatchObject({ details: { reason: 'comment already resolved' } });
    });
});
