import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateReviewCommentRequest, ReviewComment, ReviewState, ReviewTurn, ReviewTurnRequest, ReviewVerdictRequest } from '@wilson/sdk';
import { invalidateCard, invalidateCardsList } from './mutations.js';
import { API_BASE } from './sdk.js';
import { useWilsonSdk } from './sdk-context.js';

const reviewKey = (project: string | undefined, cardId: string) => ['project', project, 'card', cardId, 'review'];
const turnsKey = (project: string | undefined, cardId: string) => ['project', project, 'card', cardId, 'review', 'turns'];
const diffKey = (project: string | undefined, cardId: string) => ['project', project, 'card', cardId, 'diff'];

/** A card's review and every comment on it, located against the branch as it is now. */
export function useReviewState(project: string | undefined, cardId: string, enabled: boolean) {
    const wilson = useWilsonSdk();
    return useQuery({
        queryKey: reviewKey(project, cardId),
        queryFn: () => wilson.review.readAReview(cardId),
        enabled,
    });
}

/**
 * Rejoins the review of the branch's current commit, or starts one. The branch may have moved since the
 * diff on screen was read, so the diff is read again too, which keeps the two on the same commit.
 */
export function useOpenReview(project: string | undefined, cardId: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (): Promise<ReviewState> => wilson.review.openAReview(cardId),
        onSuccess: state => {
            queryClient.setQueryData(reviewKey(project, cardId), state);
            void queryClient.invalidateQueries({ queryKey: diffKey(project, cardId) });
            // A new commit's review starts a new conversation, and the turns may have been read just
            // before it existed.
            void queryClient.invalidateQueries({ queryKey: turnsKey(project, cardId) });
        },
    });
}

/**
 * The server's own sentence is shown beside what was typed when this is refused, as `useAddPlanComment`
 * does. The review is read again either way, because a refusal usually means the branch moved.
 */
export function useAddReviewComment(project: string | undefined, cardId: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateReviewCommentRequest): Promise<ReviewComment> => wilson.review.addAReviewComment(cardId, body),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: reviewKey(project, cardId) });
        },
    });
}

export function useResolveReviewComment(project: string | undefined, cardId: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (commentId: string): Promise<ReviewComment> => wilson.review.resolveAReviewComment(cardId, commentId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: reviewKey(project, cardId) });
        },
    });
}

/** Sends every open comment to the implementer. The card changes stage, so its own queries are read again. */
export function useRequestChanges(project: string | undefined, cardId: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: ReviewVerdictRequest): Promise<ReviewState> => wilson.review.requestChanges(cardId, body),
        onSuccess: state => {
            queryClient.setQueryData(reviewKey(project, cardId), state);
            invalidateCardsList(queryClient);
            invalidateCard(queryClient, cardId);
        },
    });
}

/** Records the person's approval. Nothing about the card changes, so only the review is read again. */
export function useApproveReview(project: string | undefined, cardId: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: ReviewVerdictRequest): Promise<ReviewState> => wilson.review.approveAReview(cardId, body),
        onSuccess: state => {
            queryClient.setQueryData(reviewKey(project, cardId), state);
        },
    });
}

/**
 * The review's conversation: the stored turns, plus the reply still being written. The stored turns are
 * the record and the stream is ephemeral, as with the chat, so someone who connects mid-turn reads what
 * came before and sees only what is still arriving, and `done` reads the turns again. `tour` rereads the
 * review, so a step list appears as the agent publishes it.
 *
 * `EventSource` can't set `X-Wilson-Project`, so the stream names its project with `?project=`, as
 * `usePlanTranscript` does.
 */
export function useReviewTranscript(project: string | undefined, cardId: string, enabled: boolean) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    const [pendingText, setPendingText] = useState('');
    const turns = useQuery({
        queryKey: turnsKey(project, cardId),
        queryFn: () => wilson.review.listReviewTurns(cardId),
        enabled,
    });

    useEffect(() => {
        if (!enabled) return;
        const streamUrl = `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/review/stream`;
        // `withCredentials`: authenticated by the API's stream cookie, as `useCardFeed`'s stream is.
        const source = new EventSource(project ? `${streamUrl}?project=${encodeURIComponent(project)}` : streamUrl, { withCredentials: true });

        const finished = () => {
            setPendingText('');
            void queryClient.invalidateQueries({ queryKey: turnsKey(project, cardId) });
        };
        source.addEventListener('delta', event => setPendingText(previous => previous + (event as MessageEvent<string>).data));
        source.addEventListener('tour', () => void queryClient.invalidateQueries({ queryKey: reviewKey(project, cardId), exact: true }));
        source.addEventListener('done', finished);
        source.addEventListener('failed', finished);

        return () => source.close();
    }, [enabled, project, cardId, queryClient]);

    return { turns: turns.data ?? [], pendingText };
}

/** Sends one turn. A refusal is the server's own sentence, shown beside the message box. */
export function useSendReviewTurn(project: string | undefined, cardId: string) {
    const wilson = useWilsonSdk();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: ReviewTurnRequest): Promise<ReviewTurn> => wilson.review.sendAReviewTurn(cardId, body),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: turnsKey(project, cardId) });
            void queryClient.invalidateQueries({ queryKey: reviewKey(project, cardId), exact: true });
        },
    });
}
