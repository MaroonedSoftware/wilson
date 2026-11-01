import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Badge, Box, Button, Group, Indicator, Mark, Popover, Stack, Text, Textarea } from '@mantine/core';
import type { PlanComment } from '@wilson/sdk';
import { Markdown } from '#src/components/Markdown.js';
import { captureAnchor, locateAnchor } from '#src/lib/anchor.js';
import { reasonFor, useAddPlanComment, useResolvePlanComment } from '#src/lib/mutations.js';
import { usePlanComments } from '#src/lib/plan.js';
import { containerText, rangeForOffsets, selectionOffsets } from '#src/lib/textPosition.js';

/** One highlight rectangle, in coordinates relative to `CommentableDraft`'s own positioned
 * wrapper — a passage that wraps onto more than one line produces more than one of these. */
interface HighlightRect {
    top: number;
    left: number;
    width: number;
    height: number;
}

/** A comment [[0145]] could still find, plus where to draw it. */
interface LocatedComment {
    comment: PlanComment;
    rects: HighlightRect[];
}

/** Every client rect of `range`, translated from viewport coordinates into coordinates relative
 * to `wrapper` — the coordinate space every absolutely-positioned overlay below is drawn in. The
 * subtraction stays correct across scrolling: `wrapper` and the range it was measured from sit in
 * the same scroll container, so a scroll moves both `wrapper`'s rect and the range's rects by the
 * same amount, leaving the difference this computes unchanged. */
function rectsRelativeTo(wrapper: HTMLElement, range: Range): HighlightRect[] {
    const wrapperRect = wrapper.getBoundingClientRect();
    return Array.from(range.getClientRects()).map(rect => ({
        top: rect.top - wrapperRect.top,
        left: rect.left - wrapperRect.left,
        width: rect.width,
        height: rect.height,
    }));
}

/**
 * One highlighted passage: the `Mark` rectangles task 2 of [[0147]] asks for, reachable via a
 * `Popover` (this card's Constraints list `Popover` and `HoverCard` as equivalent choices here;
 * `HoverCard` cannot be driven by a hover over several disjoint rects — a wrapped passage spans
 * more than one — since its own hover target has to be one element, so its open state is driven
 * by hand instead) carrying the comment's text and its resolve control. Drawn as an overlay on top
 * of what `Markdown` already rendered rather than injected into it — `Markdown.tsx` is out of
 * scope, so a comment's highlight can only ever sit beside its output, never inside it.
 */
function CommentHighlight({
    located,
    hovered,
    onHoverChange,
    resolve,
}: {
    located: LocatedComment;
    hovered: boolean;
    onHoverChange: (hovered: boolean) => void;
    resolve: ReturnType<typeof useResolvePlanComment>;
}) {
    const { comment, rects } = located;
    const first = rects[0];
    if (!first) return null;

    return (
        <>
            {rects.map((rect, index) => (
                <Mark
                    key={index}
                    color={comment.resolved ? 'gray' : 'yellow'}
                    onMouseEnter={() => onHoverChange(true)}
                    onMouseLeave={() => onHoverChange(false)}
                    style={{
                        position: 'absolute',
                        top: rect.top,
                        left: rect.left,
                        width: rect.width,
                        height: rect.height,
                        opacity: 0.5,
                        borderRadius: 2,
                        cursor: 'pointer',
                    }}
                />
            ))}
            <Popover opened={hovered} position="bottom-start" withArrow shadow="md" width={280}>
                <Popover.Target>
                    <span
                        style={{
                            position: 'absolute',
                            top: first.top,
                            left: first.left,
                            width: first.width,
                            height: first.height,
                            pointerEvents: 'none',
                        }}
                    />
                </Popover.Target>
                <Popover.Dropdown onMouseEnter={() => onHoverChange(true)} onMouseLeave={() => onHoverChange(false)}>
                    <Stack gap={6}>
                        <Text size="xs" c="dimmed" fs="italic">
                            “{comment.quote}”
                        </Text>
                        <Text size="sm">{comment.text}</Text>
                        {resolve.isError && resolve.variables === comment.id && (
                            <Text size="xs" c="red">
                                {reasonFor(resolve.error)}
                            </Text>
                        )}
                        <Group justify="space-between">
                            <Badge size="xs" color={comment.resolved ? 'gray' : 'blue'} variant="light">
                                {comment.resolved ? 'resolved' : 'open'}
                            </Badge>
                            {!comment.resolved && (
                                <Button
                                    size="xs"
                                    variant="subtle"
                                    loading={resolve.isPending && resolve.variables === comment.id}
                                    onClick={() => resolve.mutate(comment.id)}
                                >
                                    Resolve
                                </Button>
                            )}
                        </Group>
                    </Stack>
                </Popover.Dropdown>
            </Popover>
        </>
    );
}

/**
 * The compose box task 1 of [[0147]] asks for: a `Popover` (this card's Constraints) anchored to
 * the selection just made, with a `Textarea` for what got typed about it. Reports back through
 * `onSubmit`/`onCancel` rather than owning the selection itself, which belongs to
 * `CommentableDraft` — this only ever renders what it's given.
 */
function ComposeComment({
    rect,
    add,
    onSubmit,
    onCancel,
}: {
    rect: HighlightRect;
    add: ReturnType<typeof useAddPlanComment>;
    onSubmit: (text: string) => void;
    onCancel: () => void;
}) {
    const [text, setText] = useState('');

    return (
        <Popover opened position="bottom-start" withArrow shadow="md" width={280} onClose={onCancel}>
            <Popover.Target>
                <span
                    style={{ position: 'absolute', top: rect.top, left: rect.left, width: rect.width, height: rect.height, pointerEvents: 'none' }}
                />
            </Popover.Target>
            <Popover.Dropdown>
                <Stack gap={6}>
                    <Textarea
                        aria-label="Comment"
                        placeholder="Comment on this passage…"
                        autosize
                        minRows={2}
                        maxRows={6}
                        autoFocus
                        value={text}
                        onChange={event => setText(event.currentTarget.value)}
                    />
                    {add.isError && (
                        <Text size="xs" c="red">
                            {reasonFor(add.error)}
                        </Text>
                    )}
                    <Group justify="flex-end" gap={6}>
                        <Button size="xs" variant="default" disabled={add.isPending} onClick={onCancel}>
                            Cancel
                        </Button>
                        <Button size="xs" loading={add.isPending} disabled={text.trim().length === 0} onClick={() => onSubmit(text)}>
                            Comment
                        </Button>
                    </Group>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
}

/**
 * The list task 3 of [[0147]] asks for: an anchor [[0145]] cannot locate stays visible rather than
 * vanishing or guessing at a new home (this card's Constraints), marked with Mantine's
 * `Indicator` — named for exactly this in the same Constraints — since there is nowhere left in
 * the document to draw its highlight.
 */
function OutdatedComments({ comments, resolve }: { comments: PlanComment[]; resolve: ReturnType<typeof useResolvePlanComment> }) {
    if (comments.length === 0) return null;

    return (
        <Stack gap={6} mt="sm">
            <Text size="xs" c="dimmed" fw={600}>
                Outdated comments
            </Text>
            {comments.map(comment => (
                <Indicator key={comment.id} label="outdated" color="orange" size={16} position="top-start">
                    <Box p="xs" style={{ border: '1px solid var(--mantine-color-gray-4)', borderRadius: 4 }}>
                        <Stack gap={4}>
                            <Text size="xs" c="dimmed" fs="italic" td="line-through">
                                “{comment.quote}”
                            </Text>
                            <Text size="sm">{comment.text}</Text>
                            {resolve.isError && resolve.variables === comment.id && (
                                <Text size="xs" c="red">
                                    {reasonFor(resolve.error)}
                                </Text>
                            )}
                            <Group justify="space-between">
                                <Badge size="xs" color={comment.resolved ? 'gray' : 'blue'} variant="light">
                                    {comment.resolved ? 'resolved' : 'open'}
                                </Badge>
                                {!comment.resolved && (
                                    <Button
                                        size="xs"
                                        variant="subtle"
                                        loading={resolve.isPending && resolve.variables === comment.id}
                                        onClick={() => resolve.mutate(comment.id)}
                                    >
                                        Resolve
                                    </Button>
                                )}
                            </Group>
                        </Stack>
                    </Box>
                </Indicator>
            ))}
        </Stack>
    );
}

/**
 * Card [[0147]]: a layer over `DraftPane`'s rendered preview — `Markdown`, unmodified — that lets
 * a person select a passage and comment on it, following that comment through revisions via
 * [[0145]]'s `locateAnchor`/`captureAnchor` and never computing a position itself (this card's
 * Constraints: "a second locating implementation in the UI is the bug this whole split exists to
 * prevent").
 *
 * The "document text" every anchor is captured and located against is the rendered draft's own
 * visible text (`containerText`, `lib/textPosition.ts`), read straight from the DOM after
 * `Markdown` renders — not the raw markdown source. A selection is made against what's actually on
 * screen, and locating it again later has to search that same representation, or reformatting a
 * passage (say, wrapping it in `**`) would make an otherwise-untouched quote look edited even
 * though nothing a person reads changed. Selection capture and highlight placement
 * (`lib/textPosition.ts`) are the one piece of hand-written browser `Selection`/`Range` work this
 * card's Constraints carve out from Mantine; every visible piece here — the popover, the
 * highlight, the outdated list, the resolve control — is a Mantine component.
 */
export function CommentableDraft({ cardId, text }: { cardId: string; text: string }) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [renderedText, setRenderedText] = useState('');
    const [layoutVersion, setLayoutVersion] = useState(0);

    const commentsQuery = usePlanComments(cardId, true);
    const addComment = useAddPlanComment(cardId);
    const resolveComment = useResolvePlanComment(cardId);

    const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    // Recomputes the text `locateAnchor`/`captureAnchor` search once `Markdown` has actually
    // rendered `text` — after layout, so this reads the same DOM `selectionOffsets`/
    // `rangeForOffsets` below measure against, not a guess made ahead of it.
    useLayoutEffect(() => {
        setRenderedText(containerRef.current ? containerText(containerRef.current) : '');
    }, [text]);

    // Line-wrapping depends on the viewport width, which moves a highlight's rects without the
    // draft's own text changing at all — only a resize needs to force that recomputation here.
    useEffect(() => {
        const onResize = () => setLayoutVersion(v => v + 1);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const comments = commentsQuery.data ?? [];

    const located = useMemo<LocatedComment[]>(() => {
        const container = containerRef.current;
        const wrapper = wrapperRef.current;
        if (!container || !wrapper) return [];
        return comments.flatMap(comment => {
            const result = locateAnchor(renderedText, comment);
            if (result.status !== 'found') return [];
            const range = rangeForOffsets(container, result.range.start, result.range.end);
            if (!range) return [];
            return [{ comment, rects: rectsRelativeTo(wrapper, range) }];
        });
        // `layoutVersion` is read only to trigger a resize-driven recompute of the rects above;
        // its own value is never used.
    }, [comments, renderedText, layoutVersion]);

    const outdated = useMemo(() => comments.filter(comment => locateAnchor(renderedText, comment).status === 'outdated'), [comments, renderedText]);

    const pendingRect = useMemo<HighlightRect | null>(() => {
        if (!pendingSelection) return null;
        const container = containerRef.current;
        const wrapper = wrapperRef.current;
        if (!container || !wrapper) return null;
        const range = rangeForOffsets(container, pendingSelection.start, pendingSelection.end);
        const rect = range ? rectsRelativeTo(wrapper, range)[0] : undefined;
        return rect ?? null;
    }, [pendingSelection, renderedText, layoutVersion]);

    const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
        const container = containerRef.current;
        // A mouseup inside the compose popover or a highlight's popover bubbles here too — both
        // are portaled outside `container` in the DOM even though React delivers their events
        // through this component's own tree, so this only ever reacts to a selection made over
        // the draft's own text.
        if (!container || !(event.target instanceof Node) || !container.contains(event.target)) return;
        const selection = window.getSelection();
        setPendingSelection(selection ? selectionOffsets(container, selection) : null);
    };

    const cancelCompose = () => {
        setPendingSelection(null);
        window.getSelection()?.removeAllRanges();
    };

    const submitComment = (commentText: string) => {
        if (!pendingSelection) return;
        const anchor = captureAnchor(renderedText, pendingSelection.start, pendingSelection.end);
        addComment.mutate(
            { ...anchor, text: commentText },
            {
                onSuccess: () => {
                    setPendingSelection(null);
                    window.getSelection()?.removeAllRanges();
                },
            },
        );
    };

    return (
        <Box>
            <Box pos="relative" ref={wrapperRef} onMouseUp={handleMouseUp}>
                <div ref={containerRef}>
                    <Markdown body={text} />
                </div>
                {located.map(item => (
                    <CommentHighlight
                        key={item.comment.id}
                        located={item}
                        hovered={hoveredId === item.comment.id}
                        onHoverChange={hovered => setHoveredId(hovered ? item.comment.id : null)}
                        resolve={resolveComment}
                    />
                ))}
                {pendingRect && <ComposeComment rect={pendingRect} add={addComment} onSubmit={submitComment} onCancel={cancelCompose} />}
            </Box>
            {commentsQuery.error && (
                <Text size="xs" c="red" mt="xs">
                    {reasonFor(commentsQuery.error)}
                </Text>
            )}
            <OutdatedComments comments={outdated} resolve={resolveComment} />
        </Box>
    );
}
