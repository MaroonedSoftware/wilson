import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';
import type { ReviewTourAnchor, ReviewTourStep } from '@wilson/sdk';
import { Markdown } from '#src/components/Markdown.js';

const anchorLabel = ({ file, startLine, endLine }: ReviewTourAnchor): string =>
    `${file}:${startLine === endLine ? startLine : `${startLine}-${endLine}`}`;

/** Why an anchor can't be jumped to, in the words shown beside it. */
const NOT_JUMPABLE: Partial<Record<ReviewTourAnchor['status'], string>> = {
    'outside-diff': 'unchanged code',
    truncated: 'diff too large to show',
};

/** One place a step points at: a link when the diff shows it, a plain label when it doesn't. */
function AnchorLink({ anchor, onJump }: { anchor: ReviewTourAnchor; onJump: (anchor: ReviewTourAnchor) => void }) {
    if (anchor.status === 'in-diff') {
        return (
            <Button size="compact-xs" variant="subtle" ff="monospace" onClick={() => onJump(anchor)}>
                {anchorLabel(anchor)}
            </Button>
        );
    }
    return (
        <Text size="xs" ff="monospace" c="dimmed">
            {anchorLabel(anchor)} ({NOT_JUMPABLE[anchor.status]})
        </Text>
    );
}

/**
 * The agent's ordered walk through the change. Choosing a step is what moves the diff, so reading and
 * looking stay together. A person can still read the diff in any order they like, because this only ever
 * points. With no tour yet it is one button, which also stands as the retry for a turn that wrote none.
 */
export function TourRail({
    tour,
    step,
    onStep,
    onJump,
    onStart,
    starting,
    disabled,
}: {
    tour: ReviewTourStep[] | undefined;
    step: number;
    onStep: (index: number) => void;
    onJump: (anchor: ReviewTourAnchor) => void;
    onStart: () => void;
    starting: boolean;
    disabled: boolean;
}) {
    if (!tour) {
        return (
            <Paper withBorder p="sm" radius="sm">
                <Group justify="space-between" align="center">
                    <Text size="sm">An agent can read this change and walk you through it.</Text>
                    <Button size="xs" leftSection={<IconRoute size={14} />} onClick={onStart} loading={starting} disabled={disabled}>
                        Walk me through this
                    </Button>
                </Group>
            </Paper>
        );
    }

    const current = tour[step];

    return (
        <Paper withBorder p="sm" radius="sm">
            <Stack gap={8}>
                <Group gap={4}>
                    {tour.map((candidate, index) => (
                        <Button
                            key={index}
                            size="compact-xs"
                            variant={index === step ? 'filled' : 'default'}
                            aria-label={`Step ${index + 1}: ${candidate.title}`}
                            aria-current={index === step ? 'step' : undefined}
                            onClick={() => onStep(index)}
                        >
                            {index + 1}
                        </Button>
                    ))}
                </Group>
                {current && (
                    <Stack gap={6}>
                        <Group gap={6}>
                            <Badge size="xs" variant="light">
                                {step + 1} of {tour.length}
                            </Badge>
                            <Text size="sm" fw={600}>
                                {current.title}
                            </Text>
                        </Group>
                        <Markdown body={current.explanation} />
                        {current.anchors.length > 0 && (
                            <Group gap={6}>
                                {current.anchors.map((anchor, index) => (
                                    <AnchorLink key={index} anchor={anchor} onJump={onJump} />
                                ))}
                            </Group>
                        )}
                    </Stack>
                )}
                <Group justify="space-between">
                    <Button size="xs" variant="default" disabled={step === 0} onClick={() => onStep(step - 1)}>
                        Previous
                    </Button>
                    <Button size="xs" variant="default" disabled={step >= tour.length - 1} onClick={() => onStep(step + 1)}>
                        Next
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
}
