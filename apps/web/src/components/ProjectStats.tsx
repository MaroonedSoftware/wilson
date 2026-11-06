import { useState, type ReactNode } from 'react';
import { Badge, Box, Button, Group, Paper, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { DateTime } from 'luxon';
import type { ProjectDayStats, ProjectGateStats, ProjectStats as Stats } from '@wilson/sdk';
import { TONE } from '#src/components/Board.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { axisTop, compactTokens, passedOutright, percentOf, revisedCount } from '#src/lib/stats.js';

const CHART_HEIGHT = 160;

const dayLabel = (date: string): string => DateTime.fromISO(date).toFormat('d LLL');

const percent = (value: number | undefined): string => (value === undefined ? '–' : `${value}%`);

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
    return (
        <Paper withBorder p="md">
            <Text size="sm" c="dimmed">
                {label}
            </Text>
            <Text size="xl" fw={600}>
                {value}
            </Text>
            {detail && (
                <Text size="xs" c="dimmed">
                    {detail}
                </Text>
            )}
        </Paper>
    );
}

/**
 * Output tokens per day. Plain elements rather than a chart library: one series, one axis and a
 * tooltip are all this draws. Each day's whole column takes the hover, so a short bar is as easy to
 * reach as a tall one, and the table below it holds every figure for anyone not using a pointer.
 */
function DailyOutputChart({ days }: { days: ProjectDayStats[] }) {
    const top = axisTop(Math.max(...days.map(day => day.outputTokens)));
    const first = days[0];
    const last = days[days.length - 1];

    return (
        <Box role="img" aria-label={`Output tokens per day, ${days.length} days`}>
            <Group gap="xs" align="stretch" wrap="nowrap">
                <Stack justify="space-between" h={CHART_HEIGHT} gap={0} style={{ textAlign: 'right' }}>
                    {[top, top / 2, 0].map(tick => (
                        <Text key={tick} size="xs" c="dimmed" lh={1}>
                            {compactTokens(tick)}
                        </Text>
                    ))}
                </Stack>
                <Box
                    h={CHART_HEIGHT}
                    style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'flex-end',
                        gap: 2,
                        borderBottom: '1px solid var(--mantine-color-default-border)',
                    }}
                >
                    {days.map(day => (
                        <Tooltip
                            key={day.date}
                            multiline
                            label={
                                <>
                                    <Text size="xs" fw={600}>
                                        {dayLabel(day.date)}
                                    </Text>
                                    <Text size="xs">{day.outputTokens.toLocaleString()} output tokens</Text>
                                    <Text size="xs">{day.inputTokens.toLocaleString()} input tokens</Text>
                                    <Text size="xs">
                                        {day.passed} passed, {day.failed} failed
                                    </Text>
                                </>
                            }
                        >
                            <Box
                                data-testid={`day-${day.date}`}
                                style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
                            >
                                {day.outputTokens > 0 && (
                                    <Box
                                        style={{
                                            width: '100%',
                                            maxWidth: 24,
                                            height: `${(day.outputTokens / top) * 100}%`,
                                            minHeight: 2,
                                            background: 'var(--mantine-color-blue-6)',
                                            borderRadius: '4px 4px 0 0',
                                        }}
                                    />
                                )}
                            </Box>
                        </Tooltip>
                    ))}
                </Box>
            </Group>
            {first && last && (
                <Group justify="space-between" mt={4} pl={40}>
                    <Text size="xs" c="dimmed">
                        {dayLabel(first.date)}
                    </Text>
                    <Text size="xs" c="dimmed">
                        {dayLabel(last.date)}
                    </Text>
                </Group>
            )}
        </Box>
    );
}

function DailyTable({ days }: { days: ProjectDayStats[] }) {
    return (
        <Table.ScrollContainer minWidth={560}>
            <Table>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>Day</Table.Th>
                        <Table.Th>Attempts</Table.Th>
                        <Table.Th>Failed</Table.Th>
                        <Table.Th>Input tokens</Table.Th>
                        <Table.Th>Of which cached</Table.Th>
                        <Table.Th>Output tokens</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {days.map(day => (
                        <Table.Tr key={day.date}>
                            <Table.Td>{dayLabel(day.date)}</Table.Td>
                            <Table.Td>{day.attempts}</Table.Td>
                            <Table.Td>{day.failed}</Table.Td>
                            <Table.Td>{day.inputTokens.toLocaleString()}</Table.Td>
                            <Table.Td>{day.cachedInputTokens.toLocaleString()}</Table.Td>
                            <Table.Td>{day.outputTokens.toLocaleString()}</Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </Table.ScrollContainer>
    );
}

function StagesTable({ stages, revised }: { stages: Stats['stages']; revised: ProjectGateStats['revised'] }) {
    return (
        <Table.ScrollContainer minWidth={720}>
            <Table>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>Stage</Table.Th>
                        <Table.Th>Attempts</Table.Th>
                        <Table.Th>Per card</Table.Th>
                        <Table.Th>Passed</Table.Th>
                        <Table.Th>Interrupted</Table.Th>
                        <Table.Th>Input tokens</Table.Th>
                        <Table.Th>Of which cached</Table.Th>
                        <Table.Th>Output tokens</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {stages.map(stage => (
                        <Table.Tr key={stage.stage}>
                            <Table.Td>
                                <Badge size="sm" color={TONE[stage.stage] ?? 'gray'} variant="light">
                                    {stage.stage}
                                </Badge>
                            </Table.Td>
                            <Table.Td>{stage.attempts}</Table.Td>
                            <Table.Td>{stage.cards === 0 ? '–' : (stage.attempts / stage.cards).toFixed(1)}</Table.Td>
                            <Table.Td>
                                {percent(percentOf(passedOutright(stage.passed, revisedCount(revised, stage.stage)), stage.attempts))}
                            </Table.Td>
                            <Table.Td>{stage.interrupted}</Table.Td>
                            <Table.Td>{stage.inputTokens.toLocaleString()}</Table.Td>
                            <Table.Td>{stage.cachedInputTokens.toLocaleString()}</Table.Td>
                            <Table.Td>{stage.outputTokens.toLocaleString()}</Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </Table.ScrollContainer>
    );
}

const CONVERSATION_LABEL: Record<Stats['conversations'][number]['kind'], string> = { planning: 'Planning', review: 'Review' };

function ConversationsTable({ conversations }: { conversations: Stats['conversations'] }) {
    return (
        <Table.ScrollContainer minWidth={560}>
            <Table>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>Conversation</Table.Th>
                        <Table.Th>Turns</Table.Th>
                        <Table.Th>Cards</Table.Th>
                        <Table.Th>Input tokens</Table.Th>
                        <Table.Th>Of which cached</Table.Th>
                        <Table.Th>Output tokens</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {conversations.map(conversation => (
                        <Table.Tr key={conversation.kind}>
                            <Table.Td>{CONVERSATION_LABEL[conversation.kind]}</Table.Td>
                            <Table.Td>{conversation.turns}</Table.Td>
                            <Table.Td>{conversation.cards}</Table.Td>
                            <Table.Td>{conversation.inputTokens.toLocaleString()}</Table.Td>
                            <Table.Td>{conversation.cachedInputTokens.toLocaleString()}</Table.Td>
                            <Table.Td>{conversation.outputTokens.toLocaleString()}</Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </Table.ScrollContainer>
    );
}

function TopCardsTable({ project, cards }: { project: string; cards: Stats['topCards'] }) {
    return (
        <Table.ScrollContainer minWidth={560}>
            <Table>
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>Card</Table.Th>
                        <Table.Th>Attempts</Table.Th>
                        <Table.Th>Input tokens</Table.Th>
                        <Table.Th>Output tokens</Table.Th>
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {cards.map(card => (
                        <Table.Tr key={card.cardId}>
                            <Table.Td>
                                {card.cardTitle ? (
                                    <AnchorLink to="/projects/$project/cards/$cardId" params={{ project, cardId: card.cardId }} size="sm">
                                        {card.cardId} {card.cardTitle}
                                    </AnchorLink>
                                ) : (
                                    <Text size="sm" c="dimmed">
                                        {card.cardId} (no longer on the board)
                                    </Text>
                                )}
                            </Table.Td>
                            <Table.Td>{card.attempts}</Table.Td>
                            <Table.Td>{card.inputTokens.toLocaleString()}</Table.Td>
                            <Table.Td>{card.outputTokens.toLocaleString()}</Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </Table.ScrollContainer>
    );
}

const FAILURE_LABEL: Record<ProjectGateStats['failures'][number]['failureClass'], string> = {
    verifier: 'A verifier rejected the work',
    reportRejected: 'Its report was rejected',
    schemaInvalid: 'Its result did not parse',
    noReport: 'It never reported',
    resultDropped: 'Its result was lost',
    budget: 'Ran out of budget',
    engine: 'The engine failed',
    engineApi: 'The model API refused it',
    loop: 'Stopped in a loop',
    error: 'The stage threw',
};

const TOUCHPOINT_LABEL: Record<ProjectGateStats['touchpoints'][number]['cause'], string> = {
    question: 'Asked a question',
    kickbackLimit: 'Out of retries',
    overBudget: 'Over its budget',
    contextOverflow: 'Prompt too large',
    rebaseConflict: 'Rebase conflict',
    poisoned: 'Poisoned',
    dead: 'Job died',
    sourceClosed: 'Ticket closed',
    processFailure: 'Held for a process fault',
};

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const kickbackLabel = ({ reason, step }: ProjectGateStats['kickbacks'][number]): string => {
    if (reason === 'verifier') return step ? `${capitalized(step)} rejected it` : 'A verifier rejected it';
    return step ? `${capitalized(step)} upheld a revise` : 'Asked for changes';
};

/** A count, saying how much of it is an older event placed by matching its text. */
const countWithMatched = ({ count, matched }: { count: number; matched: number }): string =>
    matched > 0 ? `${count} (${matched} matched)` : `${count}`;

function GateTable({ head, rows }: { head: string[]; rows: { key: string; cells: ReactNode[] }[] }) {
    return (
        <Table>
            <Table.Thead>
                <Table.Tr>
                    {head.map(label => (
                        <Table.Th key={label}>{label}</Table.Th>
                    ))}
                </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
                {rows.map(row => (
                    <Table.Tr key={row.key}>
                        {row.cells.map((cell, index) => (
                            <Table.Td key={index}>{cell}</Table.Td>
                        ))}
                    </Table.Tr>
                ))}
            </Table.Tbody>
        </Table>
    );
}

/**
 * What the gates caught, and how often a person was pulled in before a card reached them. A kickback is
 * a judgment about the work. Every failed attempt is under "why attempts failed", most of which retry in
 * place and judge nothing, so the two overlap only at a verifier's rejection.
 */
function GatesPanel({ gates }: { gates: ProjectGateStats }) {
    const kickbacks = gates.kickbacks.reduce((sum, row) => sum + row.count, 0);
    const pulledIn = gates.touchpoints.reduce((sum, row) => sum + row.count, 0);
    const { upheld, overturned } = gates.challenge;

    return (
        <Stack gap="xs">
            <Title order={5} fw={500}>
                Gates
            </Title>
            <SimpleGrid cols={{ base: 2, md: 4 }}>
                <Tile
                    label="First pass"
                    value={percent(percentOf(gates.firstPass.firstPass, gates.firstPass.reached))}
                    detail={`${gates.firstPass.firstPass} of ${gates.firstPass.reached} cards reaching ready, no retries spent`}
                />
                <Tile
                    label="Kickbacks"
                    value={kickbacks.toLocaleString()}
                    detail={upheld + overturned > 0 ? `challenge upheld ${upheld}, overturned ${overturned}` : undefined}
                />
                <Tile
                    label="People pulled in"
                    value={pulledIn.toLocaleString()}
                    detail={`${gates.questions.asked} ${gates.questions.asked === 1 ? 'question' : 'questions'}, ${gates.questions.answered} answered`}
                />
                <Tile label="Loop stops" value={gates.loopStops.toLocaleString()} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg" mt="xs">
                {gates.kickbacks.length > 0 && (
                    <GateTable
                        head={['Kickback', 'Stage', 'Count']}
                        rows={gates.kickbacks.map(row => ({
                            key: `${row.stage}:${row.step ?? ''}:${row.reason}`,
                            cells: [
                                kickbackLabel(row),
                                <Badge key="stage" size="sm" color={TONE[row.stage] ?? 'gray'} variant="light">
                                    {row.stage}
                                </Badge>,
                                countWithMatched(row),
                            ],
                        }))}
                    />
                )}
                {gates.failures.length > 0 && (
                    <GateTable
                        head={['Why attempts failed', 'Count']}
                        rows={gates.failures.map(row => ({ key: row.failureClass, cells: [FAILURE_LABEL[row.failureClass], countWithMatched(row)] }))}
                    />
                )}
                {gates.touchpoints.length > 0 && (
                    <GateTable
                        head={['Why a person was pulled in', 'Count']}
                        rows={gates.touchpoints.map(row => ({ key: row.cause, cells: [TOUCHPOINT_LABEL[row.cause], row.count] }))}
                    />
                )}
                {gates.rules.length > 0 && (
                    <GateTable
                        head={['Rule', 'Failed', 'No verdict']}
                        rows={gates.rules.map(row => ({ key: row.rule, cells: [row.statement, row.failed, row.unavailable] }))}
                    />
                )}
            </SimpleGrid>
            {gates.matched > 0 && (
                <Text size="xs" c="dimmed">
                    {gates.matched} older failed attempts do not say why they failed, so they are placed by matching their text. Those that match
                    nothing count as a verifier's rejection.
                </Text>
            )}
        </Stack>
    );
}

/**
 * What one project spent and how its stages went over a window. Tokens only, for the reason
 * `CardUsage` gives. Planning and review turns have their own table and are in no other figure here,
 * so the stage figures keep meaning what stages spent. They are raw tokens, where an input budget
 * weights them by cost, so a stage's figure here is not what its cap was compared against.
 */
export function ProjectStats({ project, stats, gates }: { project: string; stats: Stats; gates: ProjectGateStats }) {
    const [showDays, setShowDays] = useState(false);
    const { total } = stats;
    const conversationOutput = stats.conversations.reduce((sum, conversation) => sum + conversation.outputTokens, 0);
    const hasConversations = stats.conversations.some(conversation => conversation.turns > 0);
    const hasStageRuns = total.attempts > 0 || total.interrupted > 0;

    if (!hasStageRuns && !hasConversations) {
        return (
            <Text size="sm" c="dimmed">
                Nothing has run in this window.
            </Text>
        );
    }

    const cached = percentOf(total.cachedInputTokens, total.inputTokens);
    const revised = revisedCount(gates.revised);
    const passed = passedOutright(total.passed, revised);

    return (
        <Stack gap="lg">
            <SimpleGrid cols={{ base: 2, md: 4 }}>
                <Tile
                    label="Output tokens"
                    value={compactTokens(total.outputTokens)}
                    detail={conversationOutput > 0 ? `plus ${compactTokens(conversationOutput)} in planning and review` : undefined}
                />
                <Tile label="Input tokens" value={compactTokens(total.inputTokens)} detail={`${percent(cached)} cached`} />
                <Tile
                    label="Attempts passed"
                    value={percent(percentOf(passed, total.attempts))}
                    detail={`${passed} of ${total.attempts} attempts${revised > 0 ? `, ${revised} asked for changes` : ''}`}
                />
                <Tile
                    label="Cards"
                    value={total.cards.toLocaleString()}
                    detail={
                        total.cards > 0 ? `${(total.attempts / total.cards).toFixed(1)} attempts each, ${total.interrupted} interrupted` : undefined
                    }
                />
            </SimpleGrid>

            <GatesPanel gates={gates} />

            <Stack gap="xs">
                <Group justify="space-between">
                    <Title order={5} fw={500}>
                        Output tokens per day
                    </Title>
                    <Button variant="subtle" size="compact-xs" onClick={() => setShowDays(shown => !shown)}>
                        {showDays ? 'Show as chart' : 'Show as table'}
                    </Button>
                </Group>
                {showDays ? <DailyTable days={stats.days} /> : <DailyOutputChart days={stats.days} />}
                <Text size="xs" c="dimmed">
                    Days are counted in {stats.zone}. This chart counts stage runs only.
                </Text>
            </Stack>

            <Stack gap="xs">
                <Title order={5} fw={500}>
                    By stage
                </Title>
                <StagesTable stages={stats.stages} revised={gates.revised} />
            </Stack>

            {hasConversations && (
                <Stack gap="xs">
                    <Title order={5} fw={500}>
                        Planning and review
                    </Title>
                    <ConversationsTable conversations={stats.conversations} />
                </Stack>
            )}

            <Stack gap="xs">
                <Title order={5} fw={500}>
                    Cards that wrote the most
                </Title>
                <TopCardsTable project={project} cards={stats.topCards} />
            </Stack>
        </Stack>
    );
}
