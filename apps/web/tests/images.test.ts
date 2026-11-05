import { describe, expect, it } from 'vitest';
import { MAX_DATA_URI_CHARS, imageSource } from '#src/lib/images.js';

const OTHER_SITE = 'images from other sites are not shown';
const NOT_IMAGE_DATA = 'that is not an image data URI';
const TOO_LARGE = 'that image is too large to show inline';
const NOT_ALLOWED = 'that image source is not allowed';

const oversized = `data:image/png;base64,${'A'.repeat(MAX_DATA_URI_CHARS)}`;

describe('imageSource', () => {
    it.each([
        ['/api/chat/threads/1/attachments/2', { kind: 'chat', threadId: '1', attachmentId: '2' }],
        ['/api/cards/0155/attachments/9', { kind: 'card', cardId: '0155', attachmentId: '9' }],
        ['data:image/png;base64,iVBORw0KGgo=', { kind: 'data', url: 'data:image/png;base64,iVBORw0KGgo=' }],
        ['data:image/jpeg;base64,/9j/4AAQ', { kind: 'data', url: 'data:image/jpeg;base64,/9j/4AAQ' }],
        ['data:image/gif;base64,R0lGODlh', { kind: 'data', url: 'data:image/gif;base64,R0lGODlh' }],
        ['data:image/webp;base64,UklGRg==', { kind: 'data', url: 'data:image/webp;base64,UklGRg==' }],
    ])('allows %s', (url, expected) => {
        expect(imageSource(url)).toEqual(expected);
    });

    it.each([
        ['https://evil.example/x.png', OTHER_SITE],
        ['http://evil.example/x.png', OTHER_SITE],
        ['//host/x.png', OTHER_SITE],
        ['javascript:alert(1)', NOT_ALLOWED],
        ['data:text/html;base64,AA==', NOT_IMAGE_DATA],
        ['data:image/svg+xml;base64,AA==', NOT_IMAGE_DATA],
        ['/api/chat/threads/1/attachments/2?x=1', NOT_ALLOWED],
        ['/api/chat/threads/1/attachments/2#top', NOT_ALLOWED],
        ['/api/chat/threads/1/attachments/../../2', NOT_ALLOWED],
        ['/api/chat/threads/0/attachments/2', NOT_ALLOWED],
        ['', NOT_ALLOWED],
    ])('blocks %s', (url, reason) => {
        expect(imageSource(url)).toEqual({ kind: 'blocked', reason });
    });

    it('blocks a data: image longer than the cap', () => {
        expect(oversized.length).toBeGreaterThan(MAX_DATA_URI_CHARS);
        expect(imageSource(oversized)).toEqual({ kind: 'blocked', reason: TOO_LARGE });
    });

    it('trims surrounding whitespace before matching', () => {
        expect(imageSource('  /api/chat/threads/1/attachments/2\n')).toEqual({ kind: 'chat', threadId: '1', attachmentId: '2' });
    });

    it('compares the data: scheme case-insensitively', () => {
        expect(imageSource('DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=')).toMatchObject({ kind: 'data' });
    });
});
