import { Fragment, useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Alert, Badge, Button, Group, Paper, ScrollArea, SegmentedControl, Stack, Text, Textarea, Title } from '@mantine/core';
import type { CardDiff, CardDiffFile, Review, ReviewComment, ReviewTourAnchor } from '@wilson/sdk';
import { type DiffHunk, type DiffLine, parsePatch } from '#src/lib/patch.js';
import { reasonFor } from '#src/lib/mutations.js';
import { useAddReviewComment, useApproveReview, useOpenReview, useRequestChanges, useResolveReviewComment, useReviewState } from '#src/lib/review.js';

/** Card 0265's status badge colours — the same three `git diff --name-status --no-renames` ever
 * reports (`WorktreeManager.patchSinceFork`'s own doc comment). */
const STATUS_COLOR: Record<CardDiffFile['status'], string> = {
    added: 'teal',
    modified: 'blue',
    deleted: 'red',
};

type Severity = ReviewComment['severity'];
type Side = ReviewComment['side'];

/** A place in a file's diff that a comment can be on. */
interface LineKey {
    side: Side;
    line: number;
}

/** A removed line only exists on the old side. Every other line is cited by its number in the new file. */
const keyOf = (line: DiffLine): LineKey | undefined => {
    if (line.kind === 'remove') return line.oldLine === undefined ? undefined : { side: 'old', line: line.oldLine };
    return line.newLine === undefined ? undefined : { side: 'new', line: line.newLine };
};

/**
 * One line of a hunk: old and new line numbers in a fixed-width gutter, the marker and text coloured by
 * kind. No syntax highlighting (`apps/web` has no highlighter dependency) and no side-by-side layout.
 *
 * `onSelect` is present only while comments can be written, and turns the row into the click target that
 * opens `CommentComposer` beneath it. `selected` highlights the row a composer is open for.
 */
function DiffLineRow({
    file,
    line,
    selected,
    highlighted,
    onSelect,
}: {
    file: string;
    line: DiffLine;
    selected: boolean;
    highlighted: boolean;
    onSelect: (() => void) | undefined;
}) {
    const color = line.kind === 'add' ? 'teal' : line.kind === 'remove' ? 'red' : undefined;
    const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';

    return (
        <Text
            span
            c={color}
            onClick={onSelect}
            data-diff-file={file}
            data-diff-old={line.oldLine}
            data-diff-new={line.newLine}
            style={{
                display: 'grid',
                gridTemplateColumns: '3.5em 3.5em 1.5em 1fr',
                fontFamily: 'var(--mantine-font-family-monospace)',
                fontSize: 'var(--mantine-font-size-xs)',
                whiteSpace: 'pre-wrap',
                cursor: onSelect ? 'pointer' : undefined,
                backgroundColor: selected ? 'var(--mantine-color-blue-light)' : highlighted ? 'var(--mantine-color-yellow-light)' : undefined,
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

/** The compose box a click on a line opens. What was typed stays here until the server has accepted it. */
function CommentComposer({
    onAdd,
    onCancel,
    saving,
    error,
}: {
    onAdd: (severity: Severity, text: string) => void;
    onCancel: () => void;
    saving: boolean;
    error: Error | null;
}) {
    const [severity, setSeverity] = useState<Severity>('blocker');
    const [text, setText] = useState('');

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
                    placeholder="What should change here?"
                    value={text}
                    onChange={event => setText(event.currentTarget.value)}
                    autosize
                    minRows={2}
                    autoFocus
                />
                {error && (
                    <Text size="xs" c="red">
                        {reasonFor(error)}
                    </Text>
                )}
                <Group gap={6} justify="flex-end">
                    <Button size="xs" variant="subtle" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button size="xs" disabled={text.trim().length === 0} loading={saving} onClick={() => onAdd(severity, text.trim())}>
                        Add comment
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
}

/** `blocker` reads the same red weight the diff's own `deleted` status badge uses; `concern` is a lighter caution. */
const SEVERITY_COLOR: Record<Severity, string> = {
    blocker: 'red',
    concern: 'yellow',
};

/** One stored comment, under the line it is on or in the outdated list. Only an open one can be resolved. */
function CommentCard({ comment, onResolve }: { comment: ReviewComment; onResolve: ((id: string) => void) | undefined }) {
    return (
        <Paper withBorder p="xs" radius="sm" my={4}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2}>
                    <Group gap={6}>
                        <Badge size="xs" color={SEVERITY_COLOR[comment.severity]} variant="light">
                            {comment.severity}
                        </Badge>
                        {comment.status === 'sent' && (
                            <Badge size="xs" color="gray" variant="light">
                                sent
                            </Badge>
                        )}
                    </Group>
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {comment.text}
                    </Text>
                </Stack>
                {onResolve && comment.status === 'open' && (
                    <Button size="compact-xs" variant="subtle" onClick={() => onResolve(comment.id)}>
                        Resolve
                    </Button>
                )}
            </Group>
        </Paper>
    );
}

/** Everything a hunk needs from `DiffPane` to show and write comments, already narrowed to its file. */
interface FileReview {
    /** The line a composer is open for in this file. */
    selected: LineKey | undefined;
    /** The places the tour's current step points at in this file. */
    highlights: ReviewTourAnchor[];
    /** This file's comments that locate in the current diff, and are not resolved. */
    comments: ReviewComment[];
    /** Absent while comments can't be written: outside `ready`, or until the review has loaded. */
    onSelect: ((key: LineKey) => void) | undefined;
    onAdd: (key: LineKey, severity: Severity, text: string) => void;
    onCancel: () => void;
    onResolve: ((id: string) => void) | undefined;
    saving: boolean;
    saveError: Error | null;
}

/** Whether a tour anchor covers this line, on the side the anchor names. */
const covers = (anchor: ReviewTourAnchor, line: DiffLine): boolean => {
    const number = anchor.side === 'old' ? line.oldLine : line.newLine;
    return number !== undefined && number >= anchor.startLine && number <= anchor.endLine;
};

function HunkView({ file, hunk, review }: { file: string; hunk: DiffHunk; review: FileReview }) {
    return (
        <Stack gap={0}>
            <Text size="xs" c="dimmed" style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>
                {hunk.header}
            </Text>
            {hunk.lines.map((line, index) => {
                const key = keyOf(line);
                const selected = key !== undefined && review.selected?.side === key.side && review.selected.line === key.line;
                const comments = key ? review.comments.filter(comment => comment.side === key.side && comment.currentLine === key.line) : [];
                return (
                    <Fragment key={index}>
                        <DiffLineRow
                            file={file}
                            line={line}
                            selected={selected}
                            highlighted={review.highlights.some(anchor => covers(anchor, line))}
                            onSelect={key && review.onSelect ? () => review.onSelect!(key) : undefined}
                        />
                        {comments.map(comment => (
                            <CommentCard key={comment.id} comment={comment} onResolve={review.onResolve} />
                        ))}
                        {selected && key && (
                            <CommentComposer
                                onAdd={(severity, text) => review.onAdd(key, severity, text)}
                                onCancel={review.onCancel}
                                saving={review.saving}
                                error={review.saveError}
                            />
                        )}
                    </Fragment>
                );
            })}
        </Stack>
    );
}

/** One file's own patch, parsed into hunks, or, for a truncated file, an explanation of why there
 * is nothing to parse. A patch with no hunks at all (binary content) reads as "nothing to show"
 * rather than an empty block with no explanation. */
function FileDiff({ file, review }: { file: CardDiffFile; review: FileReview }) {
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
                    <HunkView key={index} file={file.path} hunk={hunk} review={review} />
                ))}
            </Stack>
        </ScrollArea.Autosize>
    );
}

function FileEntry({ file, review }: { file: CardDiffFile; review: FileReview }) {
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
                <FileDiff file={file} review={review} />
            </Stack>
        </Paper>
    );
}

/** Comments whose line can no longer be told apart in this diff. They are never reattached, and keep the
 * line they were written on, because that is all that still says what they meant. */
function OutdatedComments({ comments, onResolve }: { comments: ReviewComment[]; onResolve: ((id: string) => void) | undefined }) {
    if (comments.length === 0) return null;

    return (
        <Paper withBorder p="sm" radius="sm">
            <Stack gap={8}>
                <Title order={5}>Outdated comments ({comments.length})</Title>
                {comments.map(comment => (
                    <Stack key={comment.id} gap={2}>
                        <Text size="xs" ff="monospace" c="dimmed">
                            {comment.file}:{comment.line} {comment.lineText.trim()}
                        </Text>
                        <CommentCard comment={comment} onResolve={onResolve} />
                    </Stack>
                ))}
            </Stack>
        </Paper>
    );
}

/** The review's two verdicts. An approval shows the commit it was for, and is not asked for twice. */
function VerdictPanel({
    review,
    openCount,
    onRequest,
    requesting,
    onApprove,
    approving,
    error,
}: {
    review: Review;
    openCount: number;
    onRequest: () => void;
    requesting: boolean;
    onApprove: () => void;
    approving: boolean;
    error: Error | null;
}) {
    const approved = review.status === 'approved';

    return (
        <Paper withBorder p="sm" radius="sm">
            <Group justify="space-between" align="center">
                <Stack gap={2}>
                    <Text size="sm">
                        {approved ? `Approved at ${review.head.slice(0, 7)}` : `${openCount} open comment${openCount === 1 ? '' : 's'}`}
                    </Text>
                    {error && (
                        <Text size="xs" c="red">
                            {reasonFor(error)}
                        </Text>
                    )}
                </Stack>
                <Group gap={6}>
                    <Button size="xs" variant="default" onClick={onRequest} loading={requesting} disabled={openCount === 0}>
                        Request changes
                    </Button>
                    {!approved && (
                        <Button size="xs" onClick={onApprove} loading={approving}>
                            Approve
                        </Button>
                    )}
                </Group>
            </Group>
        </Paper>
    );
}

/**
 * The card page's read of `GET /api/cards/{id}/diff`, the branch's own code, unified, with the card's
 * review comments on it. Comments live on the server (`review.ck`), so they survive a reload and the
 * branch moving on, and every comment is on a side: a removed line can be commented on too.
 *
 * `error` and `diff === undefined` are rendered here, not by a caller: the route's query is `enabled`
 * only once this pane is selected, so nothing here costs a request until then, which is also why the
 * review waits for `diff`. `Tabs` mounts this pane before it is ever shown.
 *
 * Only a card in `ready` can be written to, and that is `reviewable`. Anywhere else a review is read-only.
 */
export function DiffPane({
    diff,
    error,
    reviewable,
    highlights = [],
}: {
    diff: CardDiff | undefined;
    error: Error | null | undefined;
    reviewable: boolean;
    /** The places the review tour's current step points at. */
    highlights?: ReviewTourAnchor[];
}) {
    const { project, cardId = '' } = useParams({ strict: false });
    const [selected, setSelected] = useState<{ file: string; key: LineKey } | undefined>(undefined);
    const loaded = diff !== undefined;

    const state = useReviewState(project, cardId, loaded);
    const open = useOpenReview(project, cardId);
    const addComment = useAddReviewComment(project, cardId);
    const resolveComment = useResolveReviewComment(project, cardId);
    const requestChanges = useRequestChanges(project, cardId);
    const approve = useApproveReview(project, cardId);

    const { mutate: openReview } = open;
    useEffect(() => {
        if (loaded && reviewable) openReview();
    }, [loaded, reviewable, openReview]);

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

    const review = state.data?.review;
    const comments = state.data?.comments ?? [];
    const stale = review?.stale ?? false;
    const canWrite = reviewable && review !== undefined && !stale;
    const openComments = comments.filter(comment => comment.status === 'open');
    const outdated = comments.filter(comment => comment.location === 'outdated' && comment.status !== 'resolved');
    const onResolve = canWrite ? (id: string) => resolveComment.mutate(id) : undefined;

    const reviewOf = (file: CardDiffFile): FileReview => ({
        selected: selected?.file === file.path ? selected.key : undefined,
        highlights: highlights.filter(anchor => anchor.file === file.path),
        comments: comments.filter(comment => comment.file === file.path && comment.location === 'found' && comment.status !== 'resolved'),
        onSelect: canWrite
            ? key => {
                  addComment.reset();
                  setSelected(prev =>
                      prev?.file === file.path && prev.key.side === key.side && prev.key.line === key.line ? undefined : { file: file.path, key },
                  );
              }
            : undefined,
        onAdd: (key, severity, text) => {
            if (!review) return;
            addComment.mutate(
                { head: review.head, file: file.path, side: key.side, line: key.line, severity, text },
                { onSuccess: () => setSelected(undefined) },
            );
        },
        onCancel: () => setSelected(undefined),
        onResolve,
        saving: addComment.isPending,
        saveError: addComment.error,
    });

    return (
        <Stack gap="sm">
            {stale && reviewable && (
                <Alert color="yellow" title="The branch has moved on">
                    <Stack gap={6} align="flex-start">
                        <Text size="sm">
                            {review?.status === 'approved' ? `The approval was for ${review.head.slice(0, 7)}.` : 'This review read an older commit.'}{' '}
                            Comments carry over to the new one.
                        </Text>
                        <Button size="xs" onClick={() => openReview()} loading={open.isPending}>
                            Review the new commit
                        </Button>
                    </Stack>
                </Alert>
            )}
            {open.error && (
                <Alert color="red" title="Could not open the review">
                    {reasonFor(open.error)}
                </Alert>
            )}
            {canWrite && (
                <VerdictPanel
                    review={review}
                    openCount={openComments.length}
                    onRequest={() => requestChanges.mutate({ head: review.head })}
                    requesting={requestChanges.isPending}
                    onApprove={() => approve.mutate({ head: review.head })}
                    approving={approve.isPending}
                    error={requestChanges.error ?? approve.error}
                />
            )}
            {diff.truncated && (
                <Alert color="yellow" title="This diff is large">
                    Some files past the response's size budget are not shown here.
                </Alert>
            )}
            {diff.files.length === 0 && (
                <Text size="sm" c="dimmed">
                    No changes.
                </Text>
            )}
            {diff.files.map(file => (
                <FileEntry key={file.path} file={file} review={reviewOf(file)} />
            ))}
            <OutdatedComments comments={outdated} onResolve={onResolve} />
        </Stack>
    );
}
