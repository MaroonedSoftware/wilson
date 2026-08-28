import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
    SdkError,
    type CardDetail,
    type CardSummary,
    type CreateCardRequest,
    type CreatePlanCommentRequest,
    type PlanComment,
    type PlanTurn,
} from '@wilson/sdk';
import { wilson } from './sdk.js';

/**
 * The reason an API refusal names, out of `SdkError.body.details.reason` — the board write surface
 * pins `message` to the generic HTTP status text and carries the actual explanation in `details`
 * (`@maroonedsoftware/errors`' `httpError(...).withDetails({ reason })`, see
 * `BoardWriteService.move`/`.start`). The same place the CLI's `describeApiError`
 * (`packages/cli/src/api-client.ts`) reads it from, so an operator sees the same sentence either way.
 *
 * Exported for `PlanningSession.tsx`'s composer, which shows a refused turn's reason inline next to
 * the send control rather than as a notification — the same sentence, read the same way.
 */
export const reasonFor = (err: unknown): string => {
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

/**
 * Sends one turn of a card's planning conversation (card 0133's `POST .../plan/turn`), card 0137's
 * composer. Unlike the mutations above, a refusal is not a notification: `PlanningSession.tsx`
 * reads `error` itself and shows the server's own sentence inline next to the composer, the same
 * way `settings.tsx`'s controls do, since a notification would vanish before an operator mid-typing
 * necessarily saw it. Success hands back the newly appended assistant `PlanTurn` (never the user's
 * own — the endpoint only ever returns the reply), which the caller folds into the transcript kept
 * by `usePlanTranscript` (`lib/plan.ts`) via its `commitTurn`.
 */
export function useSendPlanTurn(id: string) {
    return useMutation({
        mutationFn: (text: string): Promise<PlanTurn> => wilson.board.sendAPlanTurn(id, { text }),
    });
}

/**
 * Writes an approved draft as a new card version (`POST .../plan/save`, card 0140's contract).
 * The confirmation this is meant to follow — a diff shown, a person confirming — already happened
 * in `DraftPane.tsx` before this is ever called; validation is `PlanService.save`'s alone (this
 * card's Constraints), so a refusal here is the server's own sentence, never a client-side guess
 * at why. Like `useSendPlanTurn`, a refusal is not a notification: `DraftPane` reads `error` itself
 * and renders it next to the draft, which must stay on screen rather than be lost to a toast that
 * outlives neither the mistake nor the unsaved edit.
 *
 * Success writes the response straight into `['card', id]`'s cache, the same "only ever show what
 * round-tripped" rule `settings.tsx`'s controls follow, so the card's page reflects its new version
 * the moment the write lands rather than waiting on a refetch.
 */
export function useSaveAPlanDraft(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: string) => wilson.board.saveAPlanDraft(id, { body }),
        onSuccess: result => {
            queryClient.setQueryData(['card', id], result);
        },
    });
}

/**
 * Adds a comment anchored to a passage of a card's plan draft (card [[0146]]'s
 * `POST .../plan/comments`) — the anchor `CommentableDraft.tsx` already captured
 * (`captureAnchor`, `lib/anchor.ts`) plus what was typed about it. Like `useSendPlanTurn` and
 * `useSaveAPlanDraft` above, a refusal is not a notification (this card's Constraints: the
 * server's own sentence, rendered the way `settings.tsx`'s controls and `DraftPane` already do
 * it): the compose box reads `error` itself and shows that sentence next to what was typed, which
 * `useMutation` leaves exactly as it was since nothing here clears it on failure. Success
 * invalidates the card's comment list (`usePlanComments`, `plan.ts`) so the new comment comes back
 * with its real `id` and `createdAt` rather than an optimistic guess at either.
 */
export function useAddPlanComment(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreatePlanCommentRequest): Promise<PlanComment> => wilson.board.addAPlanComment(id, body),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['plan-comments', id] });
        },
    });
}

/**
 * Marks a comment resolved (card [[0146]]'s `POST .../plan/comments/:commentId/resolve`) — a
 * state it moves through, never a delete, so success invalidates the comment list rather than
 * removing anything from the cache by hand. Like `useAddPlanComment` above, a refusal is not a
 * notification: it renders inline, next to the comment it belongs to, the same server sentence
 * either way (`reasonFor`).
 */
export function useResolvePlanComment(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (commentId: string): Promise<PlanComment> => wilson.board.resolveAPlanComment(id, commentId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['plan-comments', id] });
        },
    });
}

/**
 * Files a card from the board (card 0142) — the counterpart to `wilson card create`, the one
 * frequent operator action that otherwise still requires a terminal.
 *
 * No `['cards']` invalidation on success, unlike `useMoveCard`/`useStartCard` above: the new card
 * lands through the same git write every other board change does, and the feed (`lib/feed.ts`)
 * already invalidates `['cards']` off that — adding a second invalidation here would just be a
 * redundant refetch racing the one the feed already triggers. The caller (the new-card control)
 * takes the returned `CardDetail` and navigates to it directly rather than waiting on the list.
 *
 * A refusal is a notification, matching `useMoveCard`/`useStartCard`'s convention — this card's
 * Constraints ask for `@mantine/notifications`, not an inline error the way `DraftPane`'s save
 * does it — and, like every mutation here, names the server's own reason (`reasonFor`) rather than
 * a generic message. `useMutation` leaves both fields exactly as typed on a refusal since nothing
 * here clears them, so the form the control renders keeps what was typed for a retry.
 */
export function useCreateCard() {
    return useMutation({
        mutationFn: (body: CreateCardRequest): Promise<CardDetail> => wilson.board.createCard(body),
        onError: err => {
            notifications.show({ color: 'red', title: 'Could not create card', message: reasonFor(err) });
        },
    });
}
