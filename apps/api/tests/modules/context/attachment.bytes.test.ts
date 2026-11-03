import { describe, expect, it } from 'vitest';
import {
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_BYTES_PER_CARD,
    MAX_ATTACHMENTS_PER_CARD,
    contentHash,
    parseAttachmentId,
    safeFilename,
    sniffImageType,
} from '#modules/context/attachment.bytes.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const GIF = Buffer.from('GIF89a', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'latin1')]);

describe('limits', () => {
    it('are the figures card 0006 settled on', () => {
        expect(MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
        expect(MAX_ATTACHMENTS_PER_CARD).toBe(10);
        expect(MAX_ATTACHMENT_BYTES_PER_CARD).toBe(20 * 1024 * 1024);
    });
});

describe('sniffImageType', () => {
    it.each([
        ['image/png', PNG],
        ['image/jpeg', JPEG],
        ['image/gif', GIF],
        ['image/webp', WEBP],
    ])('recognises %s from its header', (type, bytes) => {
        expect(sniffImageType(bytes)).toBe(type);
    });

    it('refuses a RIFF file that is not WebP', () => {
        expect(sniffImageType(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVEfmt ', 'latin1')]))).toBeUndefined();
    });

    it('refuses text, including SVG', () => {
        expect(sniffImageType(Buffer.from('just some text'))).toBeUndefined();
        expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeUndefined();
    });

    it('refuses an empty buffer and a truncated signature', () => {
        expect(sniffImageType(Buffer.alloc(0))).toBeUndefined();
        expect(sniffImageType(PNG.subarray(0, 4))).toBeUndefined();
    });
});

describe('safeFilename', () => {
    it.each([
        ['../../etc/passwd', 'passwd'],
        ['a/b.png', 'b.png'],
        ['.hidden.png', 'hidden.png'],
        ['', 'image'],
        ['..', 'image'],
        ['-rf.png', 'rf.png'],
        ['my photo (1).png', 'my-photo-1-.png'],
    ])('%j becomes %j', (raw, expected) => {
        expect(safeFilename(raw)).toBe(expected);
    });

    it('truncates a long name to 120 characters', () => {
        expect(safeFilename('a'.repeat(400))).toBe('a'.repeat(120));
    });

    it.each(['../../etc/passwd', 'a/b.png', '.hidden.png', 'x'.repeat(400), '', '   ', '__.png', '日本語.png', 'a\\b.png'])(
        '%j matches the stored-name rule',
        raw => {
            expect(safeFilename(raw)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
        },
    );
});

describe('parseAttachmentId', () => {
    it.each(['1', '42', '9223372036854775807'])('accepts %j', raw => {
        expect(parseAttachmentId(raw)).toBe(raw);
    });

    it.each(['abc', '', '0', '-1', '0x10', ' 7 ', '007', '1.5', '9223372036854775808', '99999999999999999999'])('rejects %j', raw => {
        expect(parseAttachmentId(raw)).toBeUndefined();
    });
});

describe('contentHash', () => {
    it('is a stable sha256 hex digest that differs between images', () => {
        expect(contentHash(PNG)).toMatch(/^[0-9a-f]{64}$/);
        expect(contentHash(PNG)).toBe(contentHash(Buffer.from(PNG)));
        expect(contentHash(PNG)).not.toBe(contentHash(JPEG));
    });
});
