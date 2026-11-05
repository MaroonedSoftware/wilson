import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWilsonSdk } from './sdk-context.js';

/**
 * Which image sources the web app will draw, and how it fetches them.
 *
 * The allow-list is a code path, not a hope about CSP: every source an `![alt](url)` may name is
 * mapped here to one generated SDK method (or to an inline `data:` URI), and a source that is not on
 * the list has no function to call — so it issues no request at all, whatever the page's CSP says.
 * The SDK is also what carries the bearer token: an `<img src="/api/…">` would go out without it and
 * 401, so the bytes are fetched through the client and shown from a blob object URL.
 *
 * The URL is matched as the raw, trimmed string against anchored patterns. It is never resolved,
 * normalised or decoded: resolving is where `..`, `%2e%2e`, a protocol-relative host or a stray
 * query string turn a harmless-looking path into somewhere else. A string either is exactly one of
 * these shapes or it is refused.
 */

export type ImageSource =
    | { kind: 'chat'; threadId: string; attachmentId: string }
    | { kind: 'card'; cardId: string; attachmentId: string }
    | { kind: 'data'; url: string }
    | { kind: 'blocked'; reason: string };

/** The longest inline `data:` image drawn, in characters of the whole URI. */
export const MAX_DATA_URI_CHARS = 3_000_000;

const CHAT_IMAGE = /^\/api\/chat\/threads\/([1-9][0-9]{0,18})\/attachments\/([1-9][0-9]{0,18})$/;
/** Leading zeros allowed deliberately: card ids are zero-padded strings like `0155`. */
const CARD_IMAGE = /^\/api\/cards\/([0-9]{1,10})\/attachments\/([1-9][0-9]{0,18})$/;
/** Case-insensitive so the scheme is; the base64 alphabet already spans both cases. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/i;

const OTHER_SITE = /^(https?:)?\/\//i;
const DATA_URI = /^data:/i;

export const BLOCKED_OTHER_SITE = 'images from other sites are not shown';
export const BLOCKED_NOT_IMAGE_DATA = 'that is not an image data URI';
export const BLOCKED_TOO_LARGE = 'that image is too large to show inline';
export const BLOCKED_NOT_ALLOWED = 'that image source is not allowed';

/** Where an image URL may be drawn from, or why it may not. A pure function of the string. */
export const imageSource = (url: string): ImageSource => {
    const trimmed = url.trim();
    const chat = CHAT_IMAGE.exec(trimmed);
    if (chat?.[1] && chat[2]) return { kind: 'chat', threadId: chat[1], attachmentId: chat[2] };
    const card = CARD_IMAGE.exec(trimmed);
    if (card?.[1] && card[2]) return { kind: 'card', cardId: card[1], attachmentId: card[2] };
    if (DATA_IMAGE.test(trimmed)) {
        return trimmed.length <= MAX_DATA_URI_CHARS ? { kind: 'data', url: trimmed } : { kind: 'blocked', reason: BLOCKED_TOO_LARGE };
    }
    if (DATA_URI.test(trimmed)) return { kind: 'blocked', reason: BLOCKED_NOT_IMAGE_DATA };
    if (OTHER_SITE.test(trimmed)) return { kind: 'blocked', reason: BLOCKED_OTHER_SITE };
    return { kind: 'blocked', reason: BLOCKED_NOT_ALLOWED };
};

export const chatImageKey = (threadId: string, attachmentId: string) => ['chat-image', threadId, attachmentId] as const;
export const cardImageKey = (cardId: string, attachmentId: string) => ['card-image', cardId, attachmentId] as const;

/**
 * A URL an `<img>` can show for `source`: the `data:` URI itself, or an object URL over the bytes
 * the SDK fetched. `failed` when the source is blocked or the fetch errored; neither set while loading.
 *
 * Only the `Blob` is read off the SDK result — never its `contentType` — so the `<img>` takes its
 * type from the bytes. Attachments are content-hashed and never rewritten, so the bytes are cached
 * for good and a failure is not retried.
 */
export function useImageBlobUrl(source: ImageSource): { url?: string; failed: boolean } {
    const wilson = useWilsonSdk();
    const query = useQuery({
        queryKey:
            source.kind === 'chat'
                ? chatImageKey(source.threadId, source.attachmentId)
                : source.kind === 'card'
                  ? cardImageKey(source.cardId, source.attachmentId)
                  : ['no-image'],
        queryFn: async (): Promise<Blob> => {
            if (source.kind === 'chat') return (await wilson.chat.fetchAChatImage(source.threadId, source.attachmentId)).data;
            if (source.kind === 'card') return (await wilson.context.fetchAnAttachment(source.cardId, source.attachmentId)).data;
            throw new Error('no image to fetch');
        },
        enabled: source.kind === 'chat' || source.kind === 'card',
        staleTime: Infinity,
        retry: false,
    });

    // Made in an effect and revoked in its cleanup, never in render: one object URL per blob, freed
    // when the blob changes or the component unmounts (and safe under StrictMode's remount).
    const blob = query.data;
    const [objectUrl, setObjectUrl] = useState<{ blob: Blob; url: string }>();
    useEffect(() => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        setObjectUrl({ blob, url });
        return () => URL.revokeObjectURL(url);
    }, [blob]);

    if (source.kind === 'data') return { url: source.url, failed: false };
    if (source.kind === 'blocked' || query.isError) return { failed: true };
    // An object URL made for an earlier blob has been revoked already; wait for this blob's own.
    return objectUrl && objectUrl.blob === blob ? { url: objectUrl.url, failed: false } : { failed: false };
}
