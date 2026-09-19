import { Badge, Group, List, Stack, Text, Title } from '@mantine/core';
import type { CardEvent } from '@wilson/sdk';

/** One of the three ways a review can account for a criterion (`ReviewCriterionStatus`, apps/api/src/modules/stages/stage.result.ts). */
type CriterionStatus = 'met' | 'unmet' | 'unverifiable';

const STATUS_COLOR: Record<CriterionStatus, string> = {
    met: 'green',
    unmet: 'red',
    unverifiable: 'gray',
};

const isCriterionStatus = (value: unknown): value is CriterionStatus => value === 'met' || value === 'unmet' || value === 'unverifiable';

/**
 * The `criteria` array from one review's `stage.passed`/`stage.failed` payload
 * (`ReviewResultSchema.criteria`, apps/api/src/modules/stages/stage.result.ts), narrowed by hand.
 * `CardEvent.payload` carries no per-`type` union on the wire — the same reason `deferredReason`
 * (`CardDetail.tsx`) narrows `dispatch.deferred`'s payload instead of trusting a type that does not
 * exist there either.
 */
function criteriaFromPayload(payload: unknown): { id: string; status: CriterionStatus }[] | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const result = (payload as { result?: unknown }).result;
    if (typeof result !== 'object' || result === null) return undefined;
    const criteria = (result as { criteria?: unknown }).criteria;
    if (!Array.isArray(criteria)) return undefined;

    const parsed: { id: string; status: CriterionStatus }[] = [];
    for (const entry of criteria) {
        if (typeof entry !== 'object' || entry === null) continue;
        const id = (entry as { id?: unknown }).id;
        const status = (entry as { status?: unknown }).status;
        if (typeof id === 'string' && isCriterionStatus(status)) parsed.push({ id, status });
    }
    return parsed;
}

/**
 * Card 0245. The status each criterion got from the latest review — the most recent event whose
 * `stage` is `'review'` (the stage name `review.verifier.ts` itself is registered under) and whose
 * `type` is `stage.passed` or `stage.failed` (`stage.dispatcher.ts`, the only two event types that
 * carry a stage result). `events` arrives oldest-first — the same order `EventsTimeline`
 * (`CardDetail.tsx`) reads and reverses for display — so the latest match is found walking from the
 * end.
 */
function latestReviewCriteria(events: CardEvent[] | undefined): { id: string; status: CriterionStatus }[] | undefined {
    if (!events) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!;
        if (event.stage !== 'review') continue;
        if (event.type !== 'stage.passed' && event.type !== 'stage.failed') continue;
        return criteriaFromPayload(event.payload);
    }
    return undefined;
}

/**
 * Card 0245. Card 0236 gives every acceptance criterion an ID and makes review account for each one
 * by that ID; this is where that becomes visible on the card page. Lists the plan's criteria —
 * already parsed by the caller (`acceptanceCriteria`, `lib/card.ts`) — each with a `met` / `unmet` /
 * `unverifiable` badge from the latest review's own `criteria` array, when there has been one. With
 * no review yet — or one whose payload carries no `criteria` array at all, e.g. a card last reviewed
 * before card 0236 — a criterion shows only its ID and text, the same as one no review has touched:
 * this panel is a read of what review reported, not a second opinion on it.
 */
export function CriteriaPanel({ criteria, events }: { criteria: { id: string; text: string }[]; events: CardEvent[] | undefined }) {
    const statusById = new Map((latestReviewCriteria(events) ?? []).map(criterion => [criterion.id, criterion.status]));

    return (
        <Stack gap={6}>
            <Title order={4}>Acceptance criteria</Title>
            <List size="sm" spacing={4} listStyleType="none">
                {criteria.map(criterion => {
                    const status = statusById.get(criterion.id);
                    return (
                        <List.Item key={criterion.id}>
                            <Group gap={6} wrap="nowrap" align="flex-start">
                                <Badge size="xs" color="gray" variant="outline" radius="sm" ff="monospace">
                                    {criterion.id}
                                </Badge>
                                <Text size="sm">{criterion.text}</Text>
                                {status && (
                                    <Badge size="xs" color={STATUS_COLOR[status]} variant="light" radius="sm">
                                        {status}
                                    </Badge>
                                )}
                            </Group>
                        </List.Item>
                    );
                })}
            </List>
        </Stack>
    );
}
