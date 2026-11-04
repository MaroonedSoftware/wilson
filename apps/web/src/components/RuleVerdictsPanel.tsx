import { Badge, Code, List, Stack, Text, Title } from '@mantine/core';
import type { CardEvent } from '@wilson/sdk';
import { latestRuleVerdicts, type RuleVerdictValue } from '#src/lib/rules.js';

const VERDICT: Record<RuleVerdictValue, { label: string; color: string }> = {
    pass: { label: 'Passed', color: 'green' },
    fail: { label: 'Failed', color: 'red' },
    unavailable: { label: 'No verdict', color: 'gray' },
};

/** What the independent judges said about this card's project rules at its latest review. */
export function RuleVerdictsPanel({ events }: { events: readonly CardEvent[] | undefined }) {
    const verdicts = latestRuleVerdicts(events);
    if (verdicts.length === 0) return null;
    return (
        <Stack gap="xs">
            <Title order={4}>Checked rules</Title>
            <List spacing="xs" listStyleType="none" aria-label="Rule verdicts">
                {verdicts.map(verdict => (
                    <List.Item key={verdict.rule}>
                        <Stack gap={2}>
                            <Text size="sm" component="div">
                                <Badge size="sm" variant="light" color={VERDICT[verdict.verdict].color} mr="xs">
                                    {VERDICT[verdict.verdict].label}
                                </Badge>
                                <Code>{verdict.rule}</Code>
                                {verdict.file && (
                                    <Text span size="sm" ml="xs">
                                        <Code>{`${verdict.file}${verdict.line ? `:${verdict.line}` : ''}`}</Code>
                                    </Text>
                                )}
                            </Text>
                            {verdict.statement && (
                                <Text size="xs" c="dimmed">
                                    {verdict.statement}
                                </Text>
                            )}
                            {verdict.verdict !== 'pass' && verdict.evidence && <Text size="sm">{verdict.evidence}</Text>}
                        </Stack>
                    </List.Item>
                ))}
            </List>
        </Stack>
    );
}
