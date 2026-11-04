import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Code, Group, Loader, Paper, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import type { Rule, RuleJudgeSetting, WilsonSdk } from '@wilson/sdk';
import { apiErrorMessage } from '#src/lib/api.error.js';
import { AnchorLink } from '#src/lib/router-link.js';
import { parseGlobs } from '#src/lib/rules.js';
import { wilsonForProject } from '#src/lib/sdk.js';

const rulesQueryKey = (project: string) => ['project', project, 'rules'];
const routeQueryKey = (project: string) => ['project', project, 'rule-judge'];

type Severity = Rule['severity'];

interface RuleDraft {
    id: string;
    statement: string;
    paths: string;
    severity: Severity;
}

const EMPTY_DRAFT: RuleDraft = { id: '', statement: '', paths: '', severity: 'blocker' };

const SEVERITIES = [
    { value: 'blocker', label: 'Blocker: can send a card back' },
    { value: 'concern', label: 'Concern: only reports' },
];

/** Adds a rule, or changes the one it was opened on, whose id then stays what it is. */
function RuleForm({ project, client, editing, onDone }: { project: string; client: WilsonSdk; editing?: Rule; onDone: () => void }) {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState<RuleDraft>(
        editing ? { id: editing.id, statement: editing.statement, paths: editing.paths.join('\n'), severity: editing.severity } : EMPTY_DRAFT,
    );
    const save = useMutation({
        mutationFn: () => {
            const fields = { statement: draft.statement, paths: parseGlobs(draft.paths), severity: draft.severity };
            return editing ? client.rules.updateRule(editing.id, fields) : client.rules.createRule({ id: draft.id, ...fields });
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: rulesQueryKey(project) });
            setDraft(EMPTY_DRAFT);
            onDone();
        },
    });
    const incomplete = !draft.statement.trim() || !draft.paths.trim() || (!editing && !draft.id.trim());

    return (
        <Paper withBorder p="md">
            <Stack gap="sm">
                <Title order={5} fw={500}>
                    {editing ? `Change ${editing.id}` : 'Add a rule'}
                </Title>
                {!editing && (
                    <TextInput
                        label="Id"
                        description="A short name: lower-case letters, digits and hyphens"
                        value={draft.id}
                        onChange={event => setDraft({ ...draft, id: event.currentTarget.value })}
                    />
                )}
                <Textarea
                    label="Statement"
                    description="What must hold in the code. A judge reads this and the diff, and nothing else about the project"
                    autosize
                    minRows={2}
                    value={draft.statement}
                    onChange={event => setDraft({ ...draft, statement: event.currentTarget.value })}
                />
                <Textarea
                    label="Paths"
                    description="Globs of the files it is about, one per line. Each rule that matches a diff is one model call"
                    autosize
                    minRows={2}
                    value={draft.paths}
                    onChange={event => setDraft({ ...draft, paths: event.currentTarget.value })}
                />
                <Select
                    label="Severity"
                    data={SEVERITIES}
                    allowDeselect={false}
                    value={draft.severity}
                    onChange={value => value && setDraft({ ...draft, severity: value as Severity })}
                />
                {save.error && (
                    <Alert color="red" title="Not saved">
                        {apiErrorMessage(save.error)}
                    </Alert>
                )}
                <Group gap="xs">
                    <Button size="xs" disabled={incomplete} loading={save.isPending} onClick={() => save.mutate()}>
                        Save
                    </Button>
                    {editing && (
                        <Button size="xs" variant="subtle" onClick={onDone}>
                            Cancel
                        </Button>
                    )}
                </Group>
            </Stack>
        </Paper>
    );
}

function RulesTable({ project, client, rules, onEdit }: { project: string; client: WilsonSdk; rules: Rule[]; onEdit: (rule: Rule) => void }) {
    const queryClient = useQueryClient();
    const remove = useMutation({
        mutationFn: (id: string) => client.rules.deleteRule(id, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: rulesQueryKey(project) }),
    });

    if (rules.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No rules yet. A rule is checked by its own model call at every review whose diff touches its paths.
            </Text>
        );
    }
    return (
        <Stack gap="xs">
            {remove.error && (
                <Alert color="red" title="Not removed">
                    {apiErrorMessage(remove.error)}
                </Alert>
            )}
            <Table aria-label="Rules" verticalSpacing="sm">
                <Table.Thead>
                    <Table.Tr>
                        <Table.Th>Rule</Table.Th>
                        <Table.Th>Severity</Table.Th>
                        <Table.Th>Paths</Table.Th>
                        <Table.Th />
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {rules.map(rule => (
                        <Table.Tr key={rule.id}>
                            <Table.Td>
                                <Code>{rule.id}</Code>
                                <Text size="sm" mt={4}>
                                    {rule.statement}
                                </Text>
                            </Table.Td>
                            <Table.Td>
                                <Badge size="sm" variant="light" color={rule.severity === 'blocker' ? 'red' : 'yellow'}>
                                    {rule.severity}
                                </Badge>
                            </Table.Td>
                            <Table.Td>
                                <Stack gap={2}>
                                    {rule.paths.map(path => (
                                        <Code key={path}>{path}</Code>
                                    ))}
                                </Stack>
                            </Table.Td>
                            <Table.Td>
                                <Group gap="xs" wrap="nowrap">
                                    <Button size="compact-xs" variant="subtle" onClick={() => onEdit(rule)}>
                                        Change
                                    </Button>
                                    <Button
                                        size="compact-xs"
                                        variant="subtle"
                                        color="red"
                                        aria-label={`Remove ${rule.id}`}
                                        loading={remove.isPending && remove.variables === rule.id}
                                        onClick={() => remove.mutate(rule.id)}
                                    >
                                        Remove
                                    </Button>
                                </Group>
                            </Table.Td>
                        </Table.Tr>
                    ))}
                </Table.Tbody>
            </Table>
        </Stack>
    );
}

/** Which engine and model the judges run on, apart from any lane's routing. */
function JudgeRouteForm({ project, client }: { project: string; client: WilsonSdk }) {
    const queryClient = useQueryClient();
    const route = useQuery({ queryKey: routeQueryKey(project), queryFn: () => client.settings.getRuleJudgeSetting() });
    const [draft, setDraft] = useState<RuleJudgeSetting | undefined>();
    useEffect(() => {
        if (route.data) setDraft(route.data);
    }, [route.data]);
    const save = useMutation({
        mutationFn: (next: RuleJudgeSetting) => client.settings.setRuleJudgeSetting(next),
        onSuccess: result => queryClient.setQueryData(routeQueryKey(project), result),
    });

    if (route.error) {
        return (
            <Alert color="red" title="Cannot load the judges' route">
                {apiErrorMessage(route.error)}
            </Alert>
        );
    }
    if (!draft) return <Loader size="sm" />;
    return (
        <Paper withBorder p="md">
            <Stack gap="sm">
                <Title order={5} fw={500}>
                    Judges
                </Title>
                <Text size="sm" c="dimmed">
                    The engine and model every rule is judged on, whatever engine its review lane runs on. The cli engine uses this machine&apos;s
                    subscription and always runs Claude. The api engine needs the provider&apos;s key, and bills per token.
                </Text>
                <Group align="flex-end" gap="sm">
                    <Select
                        label="Engine"
                        data={['cli', 'api']}
                        allowDeselect={false}
                        value={draft.engine}
                        onChange={value => value && setDraft({ ...draft, engine: value as RuleJudgeSetting['engine'] })}
                    />
                    <Select
                        label="Provider"
                        data={['anthropic', 'openai', 'xai']}
                        allowDeselect={false}
                        value={draft.provider}
                        onChange={value => value && setDraft({ ...draft, provider: value as RuleJudgeSetting['provider'] })}
                    />
                    <TextInput label="Model" value={draft.model} onChange={event => setDraft({ ...draft, model: event.currentTarget.value })} />
                    <Button size="sm" loading={save.isPending} disabled={!draft.model.trim()} onClick={() => save.mutate(draft)}>
                        Save
                    </Button>
                </Group>
                {save.error && (
                    <Alert color="red" title="Not saved">
                        {apiErrorMessage(save.error)}
                    </Alert>
                )}
            </Stack>
        </Paper>
    );
}

/**
 * A project's checked rules. Every change here asks the person to sign in again (`StepUpDialog`), since
 * what a project's work is judged by is the same kind of machinery as its lanes.
 */
function ProjectRulesRoute() {
    const { project } = Route.useParams();
    const client = useMemo(() => wilsonForProject(project), [project]);
    const [editing, setEditing] = useState<Rule | undefined>();
    const rules = useQuery({ queryKey: rulesQueryKey(project), queryFn: () => client.rules.listRules() });

    if (rules.error) {
        return (
            <Alert color="red" title="Cannot reach the API">
                {apiErrorMessage(rules.error)}
            </Alert>
        );
    }

    return (
        <Stack gap="md">
            <AnchorLink to="/projects/$project" params={{ project }} size="sm">
                ← Back to the board
            </AnchorLink>
            <Title order={4} fw={500}>
                Rules
            </Title>
            {rules.data ? <RulesTable project={project} client={client} rules={rules.data} onEdit={setEditing} /> : <Loader size="sm" />}
            <RuleForm key={editing?.id ?? 'new'} project={project} client={client} editing={editing} onDone={() => setEditing(undefined)} />
            <JudgeRouteForm project={project} client={client} />
        </Stack>
    );
}

export const Route = createFileRoute('/projects/$project/rules')({ component: ProjectRulesRoute });
