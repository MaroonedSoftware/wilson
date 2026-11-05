import { useState } from 'react';
import { Image, Modal, Text } from '@mantine/core';
import { imageSource, useImageBlobUrl } from '#src/lib/images.js';

/**
 * One image inside running text: a chat attachment, or an `![alt](url)` in markdown. Only a source
 * `imageSource` allows is drawn, from a URL `useImageBlobUrl` made; anything else shows its alt text.
 *
 * Phrasing content only — it sits inside a paragraph's `<p>`, so no block-level wrapper. The
 * enlarged view's `Modal` portals out of the tree.
 */
export function InlineImage({ url, alt }: { url: string; alt: string }) {
    const source = imageSource(url);
    const image = useImageBlobUrl(source);
    const [open, setOpen] = useState(false);

    if (!image.url) {
        const reason = source.kind === 'blocked' ? source.reason : image.failed ? 'the image could not be loaded' : undefined;
        return (
            <Text span c="dimmed" fs="italic" {...(reason ? { title: reason } : {})}>
                {alt}
            </Text>
        );
    }

    return (
        <>
            <Image
                src={image.url}
                alt={alt}
                mah={320}
                w="auto"
                fit="contain"
                style={{ cursor: 'zoom-in', borderRadius: 'var(--mantine-radius-sm)' }}
                role="button"
                tabIndex={0}
                onClick={() => setOpen(true)}
                onKeyDown={event => {
                    if (event.key === 'Enter') setOpen(true);
                }}
            />
            <Modal opened={open} onClose={() => setOpen(false)} size="auto" title={alt}>
                <Image src={image.url} alt={alt} />
            </Modal>
        </>
    );
}
