import { Fragment, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Alert, Badge, Button, Group, Paper, ScrollArea, SegmentedControl, Stack, Text, Textarea, Title } from '@mantine/core';
import type { CardDiff, CardDiffFile, HumanFinding } from '@wilson/sdk';
import { type DiffHunk, type DiffLine, parsePatch } from '#src/lib/patch.js';
import { reasonFor, useRecordFindings } from '#src/lib/mutations.js';

/** Card 0265's status badge colours — the same three `git diff --name-status --no-renames` ever
 * reports (`WorktreeManager.patchSinceFork`'s own doc comment). */
const STATUS_COLOR: Record<CardDiffFile['status'], string> = {
    added: 'teal',
    modified: 'blue',
    deleted: 'red',
};

/** `HumanFinding.severity`'s own two values, named here once so `CommentComposer`'s control and
 * `PendingCommentsPanel`'s badge share the same literal type rather than each widening to `string`. */
type Severity = NonNullable<HumanFinding['severity']>;

/**
 * Card 0266. One line of a hunk: old and new line numbers in a fixed-width gutter, the marker and
 * text coloured by kind. No syntax highlighting (this card's Constraints — `apps/web` has no
 * highlighter dependency) and no side-by-side layout — unified only, one line at a time.
 *
 * `onSelect`, present only for a line that exists in the new file (`line.newLine !== undefined` —
 * a removed line has nothing left in the new file for a `file:line` citation to name), turns the
 * row into the click target that opens `CommentComposer` beneath it. `selected` highlights the row
 * a composer is currently open for, so the form reads as belonging to the line above it rather than
 * floating loose in the hunk.
 */
function DiffLineRow({ line, selected, onSelect }: { line: DiffLine; selected: boolean; onSelect: (() => void) | undefined }) {
    const color = line.kind === 'add' ? 'teal' : line.kind === 'remove' ? 'red' : undefined;
    const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';

    return (
        <Text
            span
            c={color}
            onClick={onSelect}
            style={{
                display: 'grid',
                gridTemplateColumns: '3.5em 3.5em 1.5em 1fr',
                fontFamily: 'var(--mantine-font-family-monospace)',
                fontSize: 'var(--mantine-font-size-xs)',
                whiteSpace: 'pre-wrap',
                cursor: onSelect ? 'pointer' : undefined,
                backgroundColor: selected ? 'var(--mantine-color-blue-light)' : undefined,
            }}
        >
            <Text span c="dimmed" ta="right" pr={6}>
                {line.oldLine ?? ''}
            </Text>
            <Text span c="dimmed" ta="right" pr={6}>
                {line.newLine ?? ''}
            </Text>
            <Text span>{marker}</Text>
            <Text span>{line.text}</Text>
        </Text>
    );
}

/**
 * Card 0266. The compose box a click on a commentable line opens: severity, the problem and the
 * suggestion — the same two halves `ReviewFinding` already requires of a reviewer's own findings,
 * so submitting asks for nothing this card's Constraints call ceremony. Local state only; nothing
 * here reaches the network — `DiffPane` turns a submitted draft into a pending comment, held in its
 * own state until the whole batch is sent.
 */
function CommentComposer({ onAdd, onCancel }: { onAdd: (severity: Severity, problem: string, suggestion: string) => void; onCancel: () => void }) {
    const [severity, setSeverity] = useState<Severity>('blocker');
    const [problem, setProblem] = useState('');
    const [suggestion, setSuggestion] = useState('');

    const canAdd = problem.trim().length > 0 && suggestion.trim().length > 0;

    return (
        <Paper withBorder p="xs" radius="sm" my={4}>
            <Stack gap={6}>
                <SegmentedControl
                    size="xs"
                    value={severity}
                    onChange={value => setSeverity(value as Severity)}
                    data={[
                        { label: 'Blocker', value: 'blocker' },
                        { label: 'Concern', value: 'concern' },
                    ]}
                />
                <Textarea
                    size="xs"
                    placeholder="What's wrong?"
                    value={problem}
                    onChange={event => setProblem(event.currentTarget.value)}
                    autosize
                    minRows={2}
                    autoFocus
                />
                <Textarea
                    size="xs"
                    placeholder="What would fix it?"
                    value={suggestion}
                    onChange={event => setSuggestion(event.currentTarget.value)}
                    autosize
                    minRows={2}
                />
                <Group gap={6} justify="flex-end">
                    <Button size="xs" variant="subtle" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button size="xs" disabled={!canAdd} onClick={() => onAdd(severity, problem.trim(), suggestion.trim())}>
                        Add comment
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
}

/**
 * Card 0266. `activeLine`/`onSelectLine`/`onAddComment`/`onCancelComment` are `DiffPane`'s own
 * state and callbacks, threaded down through `FileDiff` so a click anywhere in this file's hunks
 * opens exactly one `CommentComposer`, directly under the line clicked, whichever hunk it is in.
 * No `filePath` here — `FileDiff`'s own caller (`FileEntry`) already closes `onSelectLine`/
 * `onAddComment` over the file they belong to, so this component only ever deals in line numbers.
 */
function HunkView({
    hunk,
    activeLine,
    onSelectLine,
    onAddComment,
    onCancelComment,
}: {
    hunk: DiffHunk;
    activeLine: number | undefined;
    onSelectLine: (line: number) => void;
    onAddComment: (line: number, severity: Severity, problem: string, suggestion: string) => void;
    onCancelComment: () => void;
}) {
    return (
        <Stack gap={0}>
            <Text
                size="xs"
                c="dimmed"
                style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
            >
                {hunk.header}
            </Text>
            {hunk.lines.map((line, index) => {
                const commentable = line.newLine !== undefined;
                const selected = commentable && line.newLine === activeLine;
                return (
                    <Fragment key={index}>
                        <DiffLineRow line={line} selected={selected} onSelect={commentable ? () => onSelectLine(line.newLine!) : undefined} />
                        {selected && (
                            <CommentComposer
                                onAdd={(severity, problem, suggestion) => onAddComment(line.newLine!, severity, problem, suggestion)}
                                onCancel={onCancelComment}
                            />
                        )}
                    </Fragment>
                );
            })}
        </Stack>
    );
}

/** One file's own patch, parsed into hunks — or, for a truncated file, an explanation of why there
 * is nothing to parse. A patch with no hunks at all (binary content) reads as "nothing to show"
 * rather than an empty block with no explanation. */
function FileDiff({
    file,
    activeLine,
    onSelectLine,
    onAddComment,
    onCancelComment,
}: {
    file: CardDiffFile;
    activeLine: number | undefined;
    onSelectLine: (line: number) => void;
    onAddComment: (line: number, severity: Severity, problem: string, suggestion: string) => void;
    onCancelComment: () => void;
}) {
    if (file.truncated) {
        return (
            <Text size="sm" c="dimmed">
                This file's diff is too large to show here.
            </Text>
        );
    }

    const hunks = parsePatch(file.patch);
    if (hunks.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No text hunks to show (binary content, or no changes to this file's text).
            </Text>
        );
    }

    return (
        <ScrollArea.Autosize mah={480} type="auto">
            <Stack gap="sm" p={4}>
                {hunks.map((hunk, index) => (
                    <HunkView
                        key={index}
                        hunk={hunk}
                        activeLine={activeLine}
                        onSelectLine={onSelectLine}
                        onAddComment={onAddComment}
                        onCancelComment={onCancelComment}
                    />
                ))}
            </Stack>
        </ScrollArea.Autosize>
    );
}

function FileEntry({
    file,
    activeLine,
    onSelectLine,
    onAddComment,
    onCancelComment,
}: {
    file: CardDiffFile;
    /** The line a composer is open for in *this* file, or `undefined` when either nothing is open
     * or the open composer belongs to a different file — `DiffPane` only ever passes a line number
     * through here once it has already matched the file. */
    activeLine: number | undefined;
    onSelectLine: (line: number) => void;
    onAddComment: (line: number, severity: Severity, problem: string, suggestion: string) => void;
    onCancelComment: () => void;
}) {
    return (
        <Paper withBorder p="xs" radius="sm">
            <Stack gap={6}>
                <Group gap={6} wrap="nowrap">
                    <Badge size="xs" color={STATUS_COLOR[file.status]} variant="light">
                        {file.status}
                    </Badge>
                    <Text size="sm" ff="monospace">
                        {file.path}
                    </Text>
                </Group>
                <FileDiff file={file} activeLine={activeLine} onSelectLine={onSelectLine} onAddComment={onAddComment} onCancelComment={onCancelComment} />
            </Stack>
        </Paper>
    );
}

/** Card 0266's severity badge colours — `blocker` reads the same red weight the diff's own
 * `deleted` status badge uses; `concern` is a lighter caution than either. */
const SEVERITY_COLOR: Record<Severity, string> = {
    blocker: 'red',
    concern: 'yellow',
};

/**
 * Card 0266. Every comment collected so far, held in the browser until submitted (AC6) — nothing
 * here is a card version or a finding until `Submit` actually lands. Renders nothing when there is
 * nothing pending, so a card with no comments yet shows exactly what it did before this card.
 */
function PendingCommentsPanel({
    pending,
    onRemove,
    onSubmit,
    submitting,
    error,
}: {
    pending: HumanFinding[];
    onRemove: (index: number) => void;
    onSubmit: () => void;
    submitting: boolean;
    error: Error | null | undefined;
}) {
    if (pending.length === 0) return null;

    return (
        <Paper withBorder p="sm" radius="sm">
            <Stack gap={8}>
                <Title order={5}>
                    Pending comments ({pending.length})
                </Title>
                {pending.map((comment, index) => (
                    <Group key={index} justify="space-between" wrap="nowrap" align="flex-start">
                        <Stack gap={2}>
                            <Group gap={6}>
                                <Badge size="xs" color={SEVERITY_COLOR[comment.severity ?? 'blocker']} variant="light">
                                    {comment.severity ?? 'blocker'}
                                </Badge>
                                <Text size="xs" ff="monospace" c="dimmed">
                                    {comment.file}:{comment.line}
                                </Text>
                            </Group>
                            <Text size="sm">{comment.problem}</Text>
                            <Text size="sm" c="dimmed">
                                {comment.suggestion}
                            </Text>
                        </Stack>
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => onRemove(index)}>
                            Remove
                        </Button>
                    </Group>
                ))}
                {error && (
                    <Text size="xs" c="red">
                        {reasonFor(error)}
                    </Text>
                )}
                <Group justify="flex-end">
                    <Button size="xs" onClick={onSubmit} loading={submitting}>
                        Submit {pending.length} comment{pending.length === 1 ? '' : 's'}
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
}

/**
 * Card 0265. The card page's read of `GET /api/cards/{id}/diff` — the branch's own code, unified,
 * beside the plan and `MergeControl` on the same screen instead of only through `wilson card diff`
 * in a terminal.
 *
 * `error` and `diff === undefined` are rendered here, not by a caller: `DiffTabRoute`'s query is
 * `enabled` only once this pane is actually selected (this card's Constraints — no request until
 * opened), so this pane's own loading and error states are the only ones an operator ever sees for
 * it, and a failure here does not affect the rest of the card page (AC6).
 *
 * Card 0266: selecting a commentable line opens `CommentComposer` beneath it; every comment added
 * joins `pending`, held here rather than in `CardDetail.tsx` — that file is outside this card's
 * "Files in scope" — and submitted together through `useRecordFindings`. `cardId` comes from the
 * route's own params (`useParams({ strict: false })`) rather than a prop, for the same reason: the
 * Diff tab only ever renders under `/projects/$project/cards/$cardId`, so reading the param
 * directly here needs no new prop threaded through a file this card may not touch.
 */
export function DiffPane({ diff, error }: { diff: CardDiff | undefined; error: Error | null | undefined }) {
    const { cardId } = useParams({ strict: false });
    const [pending, setPending] = useState<HumanFinding[]>([]);
    const [activeLine, setActiveLine] = useState<{ file: string; line: number } | undefined>(undefined);
    const recordFindings = useRecordFindings(cardId ?? '');

    if (error) {
        return (
            <Alert color="red" title="Could not load the diff">
                {reasonFor(error)}
            </Alert>
        );
    }

    if (!diff) {
        return (
            <Text size="sm" c="dimmed">
                Loading…
            </Text>
        );
    }

    if (diff.files.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No changes.
            </Text>
        );
    }

    const addComment = (file: string, line: number, severity: Severity, problem: string, suggestion: string) => {
        setPending(prev => [...prev, { file, line, severity, problem, suggestion }]);
        setActiveLine(undefined);
    };

    const removeComment = (index: number) => {
        setPending(prev => prev.filter((_, i) => i !== index));
    };

    const submit = () => {
        if (!cardId || pending.length === 0) return;
        recordFindings.mutate(
            { findings: pending },
            {
                onSuccess: () => setPending([]),
            },
        );
    };

    return (
        <Stack gap="sm">
            {diff.truncated && (
                <Alert color="yellow" title="This diff is large">
                    Some files past the response's size budget are not shown here.
                </Alert>
            )}
            {diff.files.map(file => (
                <FileEntry
                    key={file.path}
                    file={file}
                    activeLine={activeLine?.file === file.path ? activeLine.line : undefined}
                    onSelectLine={line =>
                        setActiveLine(prev => (prev?.file === file.path && prev.line === line ? undefined : { file: file.path, line }))
                    }
                    onAddComment={(line, severity, problem, suggestion) => addComment(file.path, line, severity, problem, suggestion)}
                    onCancelComment={() => setActiveLine(undefined)}
                />
            ))}
            <PendingCommentsPanel
                pending={pending}
                onRemove={removeComment}
                onSubmit={submit}
                submitting={recordFindings.isPending}
                error={recordFindings.error}
            />
        </Stack>
    );
}
