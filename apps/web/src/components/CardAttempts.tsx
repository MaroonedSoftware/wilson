import { Badge, Code, Group, Paper, Stack, Text } from '@mantine/core';
import type { CardEvent } from '@wilson/sdk';
import { TONE } from '#src/components/Board.js';
import { groupAttempts, type AttemptOutcome, type CardAttempt } from '#src/lib/attempts.js';
import { formatTimestamp } from '#src/lib/card.js';

const OUTCOME_COLOR: Record<AttemptOutcome, string> = {
    running: 'blue',
    interrupted: 'gray',
    passed: 'green',
    failed: 'red',
    poisoned: 'red',
    dead: 'red',
};

/** The one-line tally under an attempt's heading. */
const attemptTally = (attempt: CardAttempt): string =>
    [
        attempt.inputTokens !== undefined && `${attempt.inputTokens} input tokens`,
        `${attempt.toolCalls} tool calls`,
        attempt.denials > 0 && `${attempt.denials} refused`,
        attempt.reads !== undefined && `${attempt.reads} reads`,
    ]
        .filter(Boolean)
        .join(' · ');

function AttemptCard({ attempt }: { attempt: CardAttempt }) {
    return (
        <Paper withBorder p="xs">
            <Stack gap={4}>
                <Group gap={6}>
                    <Badge size="xs" color={TONE[attempt.stage] ?? 'gray'} variant="light">
                        {attempt.stage}
                    </Badge>
                    <Badge size="xs" color={OUTCOME_COLOR[attempt.outcome]}>
                        {attempt.outcome}
                    </Badge>
                    <Text size="xs" c="dimmed">
                        {formatTimestamp(attempt.startedAt)}
                    </Text>
                </Group>
                <Text size="xs" c="dimmed">
                    {attemptTally(attempt)}
                </Text>
                {attempt.failures.map(failure => (
                    <Text key={failure} size="xs" c="red">
                        {failure}
                    </Text>
                ))}
                {attempt.finalMessage && (
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {attempt.finalMessage}
                    </Text>
                )}
                {attempt.readPaths.length > 0 && (
                    <Group gap={4}>
                        {attempt.readPaths.map(path => (
                            <Code key={path}>{path}</Code>
                        ))}
                    </Group>
                )}
            </Stack>
        </Paper>
    );
}

/** A card's runs, newest first: what each one did, read and last said, and how it ended. */
export function CardAttempts({ events }: { events: CardEvent[] | undefined }) {
    const attempts = groupAttempts(events ?? []);
    if (attempts.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No attempts yet.
            </Text>
        );
    }
    return (
        <Stack gap="xs">
            {attempts.map(attempt => (
                <AttemptCard key={attempt.id} attempt={attempt} />
            ))}
        </Stack>
    );
}
