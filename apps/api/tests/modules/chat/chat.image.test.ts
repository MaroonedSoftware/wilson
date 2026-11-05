import { describe, expect, it } from 'vitest';
import {
    decodeCreatedImage,
    MAX_CREATED_IMAGE_BYTES,
    MAX_CREATED_IMAGES_PER_TURN,
    MAX_CREATED_SVG_BYTES,
    sanitiseSvg,
} from '#modules/chat/chat.image.js';

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (inner: string, rootAttributes = NS) => `<svg ${rootAttributes}>${inner}</svg>`;

const accepted = (source: string) => {
    const result = sanitiseSvg(source);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    return result.bytes;
};
const reasonFor = (source: string): string => {
    const result = sanitiseSvg(source);
    if (result.ok) throw new Error('accepted');
    return result.reason;
};

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size: number): Buffer => Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length, 1)]);

describe('caps', () => {
    it('are the figures the plan names', () => {
        expect(MAX_CREATED_SVG_BYTES).toBe(1024 * 1024);
        expect(MAX_CREATED_IMAGE_BYTES).toBe(2 * 1024 * 1024);
        expect(MAX_CREATED_IMAGES_PER_TURN).toBe(5);
    });
});

describe('sanitiseSvg accepts', () => {
    it('a plain svg and returns its bytes unchanged', () => {
        const source = `<svg ${NS}><rect/></svg>`;
        expect(accepted(source)).toEqual(Buffer.from(source, 'utf8'));
    });

    it('in-document references', () => {
        accepted(svg('<defs><clipPath id="clip"><rect width="5" height="5"/></clipPath></defs><use href="#clip"/>'));
        accepted(svg('<use xlink:href="#a"/>', `${NS} ${XLINK}`));
        accepted(svg('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#g)"/>'));
        accepted(svg('<g clip-path="url( #clip )"/>'));
    });

    it('a leading xml declaration, whitespace around the root, and text with the five entities', () => {
        accepted(`<?xml version="1.0" encoding="UTF-8"?>\n${svg('<text x="1" y="2">a &amp; b &lt; c &gt; &quot;d&quot; &apos;</text>')}\n`);
    });

    it('a realistic chart', () => {
        accepted(
            `<svg ${NS} viewBox="0 0 100 50" width="100" height="50" role="img" aria-label="bars">` +
                '<title>Bars</title><desc>Two bars</desc>' +
                '<g transform="translate(5 5)" font-family="sans-serif" font-size="4">' +
                '<rect x="0" y="10" width="10" height="30" fill="#4a90d9" stroke="black" stroke-width="0.5"/>' +
                '<path d="M0 0 L10 10" stroke-dasharray="1 2" marker-end="url(#arrow)"/>' +
                '<text text-anchor="middle" dominant-baseline="middle"><tspan dx="1">Q1</tspan></text>' +
                '</g>' +
                '<defs><marker id="arrow" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><polygon points="0,0 4,2 0,4"/></marker></defs>' +
                '</svg>',
        );
    });
});

describe('sanitiseSvg refuses', () => {
    it.each([
        ['<script>', svg('<script>alert(1)</script>'), /<script>/],
        ['upper-case <SCRIPT>', svg('<SCRIPT>alert(1)</SCRIPT>'), /<script>/],
        ['a namespaced script', svg('<svg:script/>'), /<script>/],
        ['<style>', svg('<style>rect{}</style>'), /<style>/],
        ['<foreignObject>', svg('<foreignObject><div/></foreignObject>'), /<foreignObject>/],
        ['<animate>', svg('<animate attributeName="x"/>'), /animation/],
        ['<animateTransform>', svg('<animateTransform/>'), /animation/],
        ['<set>', svg('<set to="1"/>'), /<set>/],
        ['<handler>', svg('<handler/>'), /<handler>/],
        ['<image>', svg('<image href="https://example.com/a.png"/>'), /<image>/],
        ['a filter', svg('<filter id="f"/>'), /<filter>.*allowed list/],
        ['a non-fragment xlink:href', svg('<use xlink:href="http://example.com/#a"/>', `${NS} ${XLINK}`), /xlink:href.*outside the document/],
        ['a non-fragment href', svg('<use href="other.svg#a"/>'), /href.*outside the document/],
        ['an onclick attribute', svg('<rect onclick="alert(1)"/>'), /event handler.*onclick/],
        ['an upper-case ONLOAD attribute', `<svg ${NS} ONLOAD="x"></svg>`, /event handler/],
        ['a style attribute', svg('<rect style="fill:red"/>'), /style attribute/],
        ['url() to another place', svg('<rect fill="url(https://example.com/a)"/>'), /url\(/],
        ['a second url() after a fragment one', svg('<rect fill="url(#a) url(https://x)"/>'), /url\(/],
        ['an encoded javascript: value', svg('<use href="&#106;avascript:alert(1)"/>'), /"&".*references/],
        ['javascript: in a plain attribute', svg('<rect fill="javascript:1"/>'), /javascript:/],
        ['data: in a plain attribute', svg('<rect fill="data:x"/>'), /data:/],
        ['a backslash escape', svg('<rect fill="u\\72l(x)"/>'), /backslash/],
        ['any other xmlns value', `<svg xmlns="http://www.w3.org/1999/xhtml"></svg>`, /xmlns=.*only/],
        ['xmlns away from the root', svg(`<g ${NS}/>`), /only on the root/],
        ['another namespace', svg('', `${NS} xmlns:html="http://www.w3.org/1999/xhtml"`), /namespace xmlns:html/],
        ['an unknown attribute', svg('<rect filter="url(#f)"/>'), /filter attribute.*allowed list/],
        ['an attribute in the wrong case', svg('<rect FILL="red"/>'), /FILL attribute/],
        ['an element in the wrong case', svg('<Rect/>'), /<Rect>/],
        ['a <!DOCTYPE prologue', `<!DOCTYPE svg>${svg('')}`, /DOCTYPE/],
        ['an <!ENTITY declaration', `<!ENTITY x "y">${svg('')}`, /ENTITY/],
        ['a CDATA section', svg('<text><![CDATA[x]]></text>'), /CDATA/],
        ['a comment', svg('<!-- hi -->'), /comment/],
        ['a processing instruction', svg('<?xml-stylesheet href="a.css"?>'), /processing instruction/],
        ['an xml declaration that is not first', ` <?xml version="1.0"?>${svg('')}`, /processing instruction/],
        ['unbalanced tags', svg('<g>'), /unclosed|balance/],
        ['a closing tag that does not match', svg('<g></rect>'), /balance/],
        ['a stray closing tag', `${svg('')}</g>`, /never opened/],
        ['two roots', `${svg('')}${svg('')}`, /more than one root/],
        ['a root that is not svg', '<g></g>', /root element is <g>/],
        ['no svg at all', '   ', /no <svg>/],
        ['text outside the root', `hello${svg('')}`, /outside/],
        ['an unknown entity in text', svg('<text>&nbsp;</text>'), /entity/],
        ['a numeric reference in text', svg('<text>&#60;</text>'), /entity/],
        ['an unquoted attribute', svg('<rect x=1/>'), /malformed attribute/],
        ['attributes run together', svg('<rect x="1"y="2"/>'), /malformed <rect>/],
        ['a repeated attribute', svg('<rect x="1" x="2"/>'), /repeats/],
        ['a bare <', svg('<text>< b</text>'), /does not start a tag/],
        ['a control character', svg('<text>\u0000</text>'), /control character/],
        ['a lone surrogate', svg('<text>\uD800</text>'), /broken character/],
    ])('%s', (_label, source, reason) => {
        expect(reasonFor(source)).toMatch(reason);
    });

    it('source over MAX_CREATED_SVG_BYTES, before scanning it', () => {
        const filler = '<script>'.repeat(Math.ceil(MAX_CREATED_SVG_BYTES / 8));
        expect(reasonFor(svg(filler))).toMatch(/over the 1048576-byte limit/);
    });

    it('measures the cap in UTF-8 bytes, not characters', () => {
        const text = 'é'.repeat(MAX_CREATED_SVG_BYTES / 2);
        expect(reasonFor(svg(`<text>${text}</text>`))).toMatch(/byte limit/);
    });
});

describe('decodeCreatedImage', () => {
    it('decodes a base64 PNG as image/png', () => {
        const bytes = png(64);
        const result = decodeCreatedImage(bytes.toString('base64'));
        expect(result).toEqual({ ok: true, bytes, contentType: 'image/png' });
    });

    it('refuses malformed base64', () => {
        const valid = png(64).toString('base64');
        for (const malformed of [`${valid}!`, ` ${valid}`, valid.replace(/=+$/, ''), valid.replace(/\+/g, '-').replace(/\//g, '_') + 'A']) {
            const result = decodeCreatedImage(malformed);
            expect(result.ok).toBe(false);
        }
        expect(decodeCreatedImage('iVBO!!!!')).toEqual({ ok: false, reason: 'the image is not valid base64' });
    });

    it('refuses an empty string', () => {
        expect(decodeCreatedImage('')).toEqual({ ok: false, reason: 'the image is empty' });
    });

    it('refuses bytes over MAX_CREATED_IMAGE_BYTES, and takes them at the cap', () => {
        expect(decodeCreatedImage(png(MAX_CREATED_IMAGE_BYTES).toString('base64')).ok).toBe(true);
        const over = decodeCreatedImage(png(MAX_CREATED_IMAGE_BYTES + 1).toString('base64'));
        expect(over.ok).toBe(false);
        expect(over.ok ? '' : over.reason).toMatch(/byte limit/);
    });

    it('refuses base64 of an SVG document, pointing at the source route', () => {
        const result = decodeCreatedImage(Buffer.from(svg('<rect/>')).toString('base64'));
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toMatch(/SVG must be sent as source/);
    });

    it('refuses bytes that are no image type', () => {
        const result = decodeCreatedImage(Buffer.from([1, 2, 3, 4]).toString('base64'));
        expect(result).toEqual({ ok: false, reason: "the image's bytes are not a PNG, JPEG, WebP or GIF image" });
    });
});
