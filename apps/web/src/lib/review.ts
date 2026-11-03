import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateReviewCommentRequest, ReviewComment, ReviewState, ReviewVerdictRequest } from '@wilson/sdk';
import { invalidateCard, invalidateCardsList } from './mutations.js';
import { wilson } from './sdk.js';

const reviewKey = (project: string | undefined, cardId: string) => ['project', project, 'card', cardId, 'review'];
const diffKey = (project: string | undefined, cardId: string) => ['project', project, 'card', cardId, 'diff'];

/** A card's review and every comment on it, located against the branch as it is now. */
export function useReviewState(project: string | undefined, cardId: string, enabled: boolean) {
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
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (): Promise<ReviewState> => wilson.review.openAReview(cardId),
        onSuccess: state => {
            queryClient.setQueryData(reviewKey(project, cardId), state);
            void queryClient.invalidateQueries({ queryKey: diffKey(project, cardId) });
        },
    });
}

/**
 * The server's own sentence is shown beside what was typed when this is refused, as `useAddPlanComment`
 * does. The review is read again either way, because a refusal usually means the branch moved.
 */
export function useAddReviewComment(project: string | undefined, cardId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateReviewCommentRequest): Promise<ReviewComment> => wilson.review.addAReviewComment(cardId, body),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: reviewKey(project, cardId) });
        },
    });
}

export function useResolveReviewComment(project: string | undefined, cardId: string) {
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
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: ReviewVerdictRequest): Promise<ReviewState> => wilson.review.approveAReview(cardId, body),
        onSuccess: state => {
            queryClient.setQueryData(reviewKey(project, cardId), state);
        },
    });
}
