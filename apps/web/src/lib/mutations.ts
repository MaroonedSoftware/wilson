import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { SdkError, type CardSummary } from '@wilson/sdk';
import { wilson } from './sdk.js';

/**
 * The reason an API refusal names, out of `SdkError.body.details.reason` — the board write surface
 * pins `message` to the generic HTTP status text and carries the actual explanation in `details`
 * (`@maroonedsoftware/errors`' `httpError(...).withDetails({ reason })`, see
 * `BoardWriteService.move`/`.start`). The same place the CLI's `describeApiError`
 * (`packages/cli/src/api-client.ts`) reads it from, so an operator sees the same sentence either way.
 */
const reasonFor = (err: unknown): string => {
    if (err instanceof SdkError) {
        const body = err.body as { details?: { reason?: string }; message?: string } | undefined;
        return body?.details?.reason ?? body?.message ?? err.message;
    }
    return err instanceof Error ? err.message : String(err);
};

/**
 * Moves a card to another stage.
 *
 * Success only invalidates `['cards']` (the board list `useCardFeed` also invalidates) and this
 * card's own `['card', id]` query — never writes the target stage into either. The runner is the
 * sole writer (PROJECT.md, Architecture); a card's displayed stage must come from a query that
 * actually re-fetched, not from what was requested. A refusal is surfaced as a notification rather
 * than swallowed, naming the API's own reason.
 */
export function useMoveCard(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (stage: string) => wilson.board.moveCard(id, { stage }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['cards'] });
            void queryClient.invalidateQueries({ queryKey: ['card', id] });
        },
        onError: err => {
            notifications.show({ color: 'red', title: 'Could not move the card', message: reasonFor(err) });
        },
    });
}

/**
 * Reorders a card within the parking lot (card 0091's `POST .../reposition`). Unlike every other
 * mutation in this file, this one *is* optimistic (PROJECT.md, Architecture; card 0047's plan):
 * ordering is not runner state — no stage reads it, nothing dispatches on it, the runner never
 * writes it — so writing the dragged order straight into the `['cards']` cache and reconciling from
 * the response is honest here in a way it would not be for `useMoveCard`'s stage change. Deliberately
 * its own hook rather than a parameterised `useMoveCard`, so a stage move and a reorder never share a
 * code path that would make the two behave the same.
 *
 * `Board.tsx` owns the reordering math — dnd-kit's `arrayMove`, and the synthetic positions that
 * stand in for the server's sparse ones until the response (or a feed event) brings the real ones
 * back — and hands the already-reordered array in as `optimisticCards`. This hook only owns the
 * cache write, the rollback on refusal, and the reconciling refetch.
 */
export function useRepositionCard() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, beforeId, afterId }: { id: string; beforeId?: string; afterId?: string; optimisticCards: CardSummary[] }) =>
            wilson.board.repositionCard(id, { beforeId, afterId }),
        onMutate: ({ optimisticCards }) => {
            const previous = queryClient.getQueryData<CardSummary[]>(['cards']);
            queryClient.setQueryData(['cards'], optimisticCards);
            return { previous };
        },
        onError: (err, _vars, context) => {
            if (context?.previous) queryClient.setQueryData(['cards'], context.previous);
            notifications.show({ color: 'red', title: 'Could not reorder the card', message: reasonFor(err) });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['cards'] });
        },
    });
}

/**
 * Enqueues a card for its stage. Same invalidation and refusal handling as `useMoveCard` — a 400
 * names why (not dispatchable, or a job already carrying the card), shown as a notification.
 */
export function useStartCard(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => wilson.board.startCard(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['cards'] });
            void queryClient.invalidateQueries({ queryKey: ['card', id] });
        },
        onError: err => {
            notifications.show({ color: 'red', title: 'Could not enqueue the card', message: reasonFor(err) });
        },
    });
}
