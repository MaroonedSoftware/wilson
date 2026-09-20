import { Alert, Badge, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import type { CardDiff, CardDiffFile } from '@wilson/sdk';
import { type DiffHunk, type DiffLine, parsePatch } from '#src/lib/patch.js';
import { reasonFor } from '#src/lib/mutations.js';

/** Card 0265's status badge colours — the same three `git diff --name-status --no-renames` ever
 * reports (`WorktreeManager.patchSinceFork`'s own doc comment). */
const STATUS_COLOR: Record<CardDiffFile['status'], string> = {
    added: 'teal',
    modified: 'blue',
    deleted: 'red',
};

/** One line of a hunk: old and new line numbers in a fixed-width gutter, the marker and text
 * coloured by kind. No syntax highlighting (this card's Constraints — `apps/web` has no
 * highlighter dependency) and no side-by-side layout — unified only, one line at a time. */
function DiffLineRow({ line }: { line: DiffLine }) {
    const color = line.kind === 'add' ? 'teal' : line.kind === 'remove' ? 'red' : undefined;
    const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';

    return (
        <Text
            span
            c={color}
            style={{
                display: 'grid',
                gridTemplateColumns: '3.5em 3.5em 1.5em 1fr',
                fontFamily: 'var(--mantine-font-family-monospace)',
                fontSize: 'var(--mantine-font-size-xs)',
                whiteSpace: 'pre-wrap',
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

function HunkView({ hunk }: { hunk: DiffHunk }) {
    return (
        <Stack gap={0}>
            <Text
                size="xs"
                c="dimmed"
                style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
            >
                {hunk.header}
            </Text>
            {hunk.lines.map((line, index) => (
                <DiffLineRow key={index} line={line} />
            ))}
        </Stack>
    );
}

/** One file's own patch, parsed into hunks — or, for a truncated file, an explanation of why there
 * is nothing to parse. A patch with no hunks at all (binary content) reads as "nothing to show"
 * rather than an empty block with no explanation. */
function FileDiff({ file }: { file: CardDiffFile }) {
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
                    <HunkView key={index} hunk={hunk} />
                ))}
            </Stack>
        </ScrollArea.Autosize>
    );
}

function FileEntry({ file }: { file: CardDiffFile }) {
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
                <FileDiff file={file} />
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
 */
export function DiffPane({ diff, error }: { diff: CardDiff | undefined; error: Error | null | undefined }) {
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

    return (
        <Stack gap="sm">
            {diff.truncated && (
                <Alert color="yellow" title="This diff is large">
                    Some files past the response's size budget are not shown here.
                </Alert>
            )}
            {diff.files.map(file => (
                <FileEntry key={file.path} file={file} />
            ))}
        </Stack>
    );
}
