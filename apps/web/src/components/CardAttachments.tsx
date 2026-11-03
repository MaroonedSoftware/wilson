import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useDisclosure } from '@mantine/hooks';
import { Button, Code, Group, Image, Loader, Modal, Paper, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { CardAttachment } from '@wilson/sdk';
import { formatTimestamp } from '#src/lib/card.js';
import { reasonFor, useAttachImage, useRemoveAttachment } from '#src/lib/mutations.js';
import { useWilsonSdk } from '#src/lib/sdk-context.js';

/**
 * Card 0010: the person's surface onto a card's attached images — card 0009 built the store and the
 * upload/list/fetch/delete API; this is where someone sees a thumbnail, adds an image, removes one,
 * and opens it full size. `CardContext.tsx`'s structure, component for component.
 *
 * No optimistic rendering: `attachments` comes straight from the query `ProjectCardDetailRoute`
 * mounts, and a successful add or remove only invalidates it, so nothing appears or disappears here
 * until the server has answered for it.
 *
 * Bytes go through the generated SDK client, never a plain `<img src="/api/...">`: the session is a
 * bearer token `sessionFetch` applies, not a cookie, so the browser's own image request would be
 * unauthenticated. Each image's `Blob` is shown from an object URL that is revoked when it goes.
 * Thumbnails are that same image rendered small by CSS — nothing is resized or decoded here.
 */

/** The types the picker offers. A convenience only: the API decides the type from the bytes. */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** A byte count as a person reads it. */
const formatSize = (bytes: number): string =>
    bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Picks one image and uploads it. `AttachContextControl`'s rules: disabled while pending, a success
 * resets the picker, and a refusal leaves it usable and shows the API's own sentence beside it, as
 * well as the notification `useAttachImage` raises. No size, count or type check here — the
 * attachment service is the only validator, and a second copy of its caps would drift.
 */
function AddImageControl({ cardId }: { cardId: string }) {
    const input = useRef<HTMLInputElement>(null);
    const attachImage = useAttachImage(cardId);

    const picked = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];
        if (!file || attachImage.isPending) return;
        const body = new FormData();
        body.append('file', file);
        attachImage.mutate(body, {
            onSuccess: () => {
                if (input.current) input.current.value = '';
            },
        });
    };

    return (
        <Group gap="xs" align="center">
            {attachImage.error && (
                <Text size="xs" c="red" data-testid="attach-image-error">
                    {reasonFor(attachImage.error)}
                </Text>
            )}
            <input ref={input} type="file" accept={ACCEPT} hidden onChange={picked} data-testid="attach-image-input" />
            <Button size="xs" variant="light" loading={attachImage.isPending} disabled={attachImage.isPending} onClick={() => input.current?.click()}>
                Add image
            </Button>
        </Group>
    );
}

/**
 * Removes one image, behind a confirmation modal — `RemoveContextControl`'s shape and its reason: a
 * stray click on a destructive action gets a step to catch it, a Mantine `Modal` rather than
 * `window.confirm`. Unlike a context snapshot, an image cannot be fetched again, so the body says so.
 */
function RemoveAttachmentControl({ cardId, attachment }: { cardId: string; attachment: CardAttachment }) {
    const [opened, handlers] = useDisclosure(false);
    const removeAttachment = useRemoveAttachment(cardId);

    const confirm = () => {
        removeAttachment.mutate(attachment.id, { onSuccess: () => handlers.close() });
    };

    return (
        <>
            <Button size="xs" variant="subtle" color="red" onClick={handlers.open}>
                Remove
            </Button>
            <Modal opened={opened} onClose={handlers.close} title="Remove this image?">
                <Stack gap="sm">
                    <Text size="sm">
                        This deletes <Code>{attachment.filename}</Code> from the card. It can only be undone by uploading the image again.
                    </Text>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={handlers.close} disabled={removeAttachment.isPending}>
                            Cancel
                        </Button>
                        <Button color="red" loading={removeAttachment.isPending} onClick={confirm}>
                            Remove
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}

/**
 * One image's bytes, fetched through the SDK and shown from an object URL, small; a click opens the
 * same URL full size. Keyed `[..., 'attachment', attachmentId]` so the list's invalidation never
 * refetches it.
 */
function AttachmentThumbnail({ project, cardId, attachment }: { project: string; cardId: string; attachment: CardAttachment }) {
    const client = useWilsonSdk();
    const [opened, handlers] = useDisclosure(false);
    const bytes = useQuery({
        queryKey: ['project', project, 'card', cardId, 'attachment', attachment.id],
        queryFn: () => client.context.fetchAnAttachment(cardId, attachment.id),
    });
    const blob = bytes.data?.data;
    const [url, setUrl] = useState<string>();

    useEffect(() => {
        if (!blob) return;
        const objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        return () => {
            URL.revokeObjectURL(objectUrl);
            setUrl(undefined);
        };
    }, [blob]);

    if (bytes.error) {
        return (
            <Text size="xs" c="red" w={96}>
                {bytes.error.message}
            </Text>
        );
    }
    if (!url) return <Loader size="xs" />;

    return (
        <>
            <UnstyledButton onClick={handlers.open} aria-label={`Open ${attachment.filename} full size`}>
                <Image src={url} alt={attachment.filename} h={64} w={96} fit="cover" radius="sm" />
            </UnstyledButton>
            <Modal opened={opened} onClose={handlers.close} title={attachment.filename} size="auto">
                <Image src={url} alt={attachment.filename} fit="contain" />
            </Modal>
        </>
    );
}

/**
 * Card 0010: the card's "Images" section, beside "Context" on the card's page — never on the board
 * tiles, where every card's images at once would be a page nobody could load. The same four render
 * states `CardContext` has: error, loading, nothing attached, the list.
 */
export function CardAttachments({
    project,
    cardId,
    attachments,
    error,
}: {
    project: string;
    cardId: string;
    attachments: CardAttachment[] | undefined;
    error: Error | null | undefined;
}) {
    return (
        <Stack gap={6}>
            <Group justify="space-between" align="center">
                <Title order={4}>Images</Title>
                <AddImageControl cardId={cardId} />
            </Group>
            {error ? (
                <Text size="sm" c="red">
                    Could not load images: {error.message}
                </Text>
            ) : !attachments ? (
                <Loader size="xs" />
            ) : attachments.length === 0 ? (
                <Text size="sm" c="dimmed">
                    Nothing attached.
                </Text>
            ) : (
                <Stack gap="xs">
                    {attachments.map(attachment => (
                        <Paper key={attachment.id} withBorder p="xs" radius="sm">
                            <Group justify="space-between" align="center" wrap="nowrap">
                                <Group gap="sm" align="center" wrap="nowrap">
                                    <AttachmentThumbnail project={project} cardId={cardId} attachment={attachment} />
                                    <Stack gap={2}>
                                        <Text size="sm" ff="monospace">
                                            {attachment.filename}
                                        </Text>
                                        <Text size="xs" c="dimmed">
                                            {formatSize(attachment.byteSize)} · added {formatTimestamp(attachment.createdAt)} by {attachment.addedBy}
                                        </Text>
                                    </Stack>
                                </Group>
                                <RemoveAttachmentControl cardId={cardId} attachment={attachment} />
                            </Group>
                        </Paper>
                    ))}
                </Stack>
            )}
        </Stack>
    );
}
