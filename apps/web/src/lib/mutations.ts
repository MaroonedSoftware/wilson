import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
 * Card 0155: deleting the top-level `/` and `/cards/$cardId` routes left `['cards']`/`['card', id]`
 * — the keys every mutation below was written against — naming caches that no longer exist. A
 * `/projects/$project/*` route keys its own board and card queries `['project', project, 'cards']`/
 * `['project', project, 'card', cardId]` (`projects.$project.index.tsx`,
 * `projects.$project.cards.$cardId.tsx`, both from card [[0153]]), and `invalidateQueries`'s default
 * match only ever matches a key that *starts with* the one it's given — `['project', 'demo', 'card',
 * id]` does not start with `['card', id]`, so a plain `{ queryKey: ['card', id] }` silently never
 * touched it even before this card, and every screen reached only through a project-scoped route
 * (now the only kind there is) would show a card's old stage until it was manually reloaded.
 *
 * `matchesCardsList`/`matchesCard` match either shape — this file's own unprefixed keys or a route's
 * `['project', project, ...]`-prefixed ones — by looking for `'cards'` anywhere in the key (there is
 * only ever one list per scope) and, for a single card, requiring the key's own last two elements to
 * be `['card', id]` rather than looking for `'card'`/id anywhere in the key: `CardDetail.tsx`'s route
 * also mounts `['project', project, 'card', id, 'events']` and `[..., 'versions']` alongside the card
 * query itself, and an anywhere-match would catch those two as well — `useSaveAPlanDraft` below calls
 * `setQueriesData` with a `CardDetail`, which would silently overwrite `events`'/`versions`' cached
 * arrays with that object and crash `EventsTimeline`/`VersionsList`'s `.length`/`.map` on the next
 * render. `useMergeCard` (`CardDetail.tsx`) reuses both predicates rather than repeating them a third
 * time — that hook already lives outside this file ("outside this card's Files in scope", card 0156).
 */
const matchesCardsList = (queryKey: readonly unknown[]) => queryKey.includes('cards');
const matchesCard = (queryKey: readonly unknown[], id: string) => {
    const last = queryKey.length - 1;
    return queryKey[last] === id && queryKey[last - 1] === 'card';
};

export function invalidateCardsList(queryClient: QueryClient) {
    void queryClient.invalidateQueries({ predicate: query => matchesCardsList(query.queryKey) });
}

export function invalidateCard(queryClient: QueryClient, id: string) {
    void queryClient.invalidateQueries({ predicate: query => matchesCard(query.queryKey, id) });
}

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
            invalidateCardsList(queryClient);
            invalidateCard(queryClient, id);
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
 *
 * Card 0155: writes through every query matching `matchesCardsList` (`getQueriesData`/
 * `setQueryData` per matched key) rather than the single literal `['cards']` key this hook used
 * before the top-level board's route was deleted — the board a drag actually happened on is reached
 * through a `/projects/$project/*` route now, whose own list lives at `['project', project,
 * 'cards']`, and writing only `['cards']` would leave that screen showing the pre-drag order until
 * an unrelated refetch happened to reconcile it.
 */
export function useRepositionCard() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, beforeId, afterId }: { id: string; beforeId?: string; afterId?: string; optimisticCards: CardSummary[] }) =>
            wilson.board.repositionCard(id, { beforeId, afterId }),
        onMutate: ({ optimisticCards }) => {
            const previous = queryClient.getQueriesData<CardSummary[]>({ predicate: query => matchesCardsList(query.queryKey) });
            previous.forEach(([key]) => queryClient.setQueryData(key, optimisticCards));
            return { previous };
        },
        onError: (err, _vars, context) => {
            context?.previous.forEach(([key, data]) => {
                if (data) queryClient.setQueryData(key, data);
            });
            notifications.show({ color: 'red', title: 'Could not reorder the card', message: reasonFor(err) });
        },
        onSuccess: () => {
            invalidateCardsList(queryClient);
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
            invalidateCardsList(queryClient);
            invalidateCard(queryClient, id);
        },
        onError: err => {
            notifications.show({ color: 'red', title: 'Could not enqueue the card', message: reasonFor(err) });
        },
    });
}

/**
 * Acknowledges a flagged card (card 0087's `POST .../ack`) — the needs-human panel's own way to
 * clear itself, this card's operator-facing end. Same shape as `useStartCard` above: success only
 * invalidates, never writes `needsHuman` itself, so the panel keeps rendering until the refetched
 * card actually says `needsHuman: false` (the runner is sole writer — PROJECT.md, Architecture,
 * this card's Constraints). A refusal is a red notification naming the server's own reason.
 */
export function useAckCard(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => wilson.board.acknowledgeAFlaggedCard(id),
        onSuccess: () => {
            invalidateCardsList(queryClient);
            invalidateCard(queryClient, id);
        },
        onError: err => {
            notifications.show({ color: 'red', title: 'Could not acknowledge the card', message: reasonFor(err) });
        },
    });
}

/**
 * Releases a card a job is carrying (card 0087's `POST .../release`) — the safe-cancel operator
 * action, joining `useStartCard`/`useMergeCard` as this card's other operator-facing end. Same
 * invalidation as `useStartCard`; success also shows a green notification naming which of the two
 * safe-to-cancel cases it was (`ReleaseResult.releasedAs`), following `useMergeCard`'s pattern
 * (`CardDetail.tsx`) since there is nowhere on a button to put that either. A genuine refusal — a
 * job actually mid-run — is a red notification naming the server's own reason, same as every other
 * mutation in this file.
 */
export function useReleaseCard(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => wilson.board.releaseCard(id),
        onSuccess: result => {
            invalidateCardsList(queryClient);
            invalidateCard(queryClient, id);
            notifications.show({ color: 'green', title: 'Released', message: `Card is now ${result.releasedAs}` });
        },
        onError: err => {
            notifications.show({ color: 'red', title: 'Could not release the card', message: reasonFor(err) });
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
 * Success writes the response straight into the card's own query cache, the same "only ever show
 * what round-tripped" rule `settings.tsx`'s controls follow, so the card's page reflects its new
 * version the moment the write lands rather than waiting on a refetch. Card 0155: written through
 * every query matching `matchesCard`, not the literal `['card', id]` key alone — a card reached
 * through a `/projects/$project/*` route keeps its own copy at `['project', project, 'card', id]`.
 */
export function useSaveAPlanDraft(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: string) => wilson.board.saveAPlanDraft(id, { body }),
        onSuccess: result => {
            queryClient.setQueriesData<CardDetail>({ predicate: query => matchesCard(query.queryKey, id) }, result);
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
