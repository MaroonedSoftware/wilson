import { sniffImageType, type AttachmentImageType } from '#modules/context/attachment.bytes.js';

/**
 * Checks for an image the chat creates rather than one a person uploads.
 *
 * SVG is refused rather than cleaned. A cleaner has to understand every way a browser could read the
 * markup — entities, escapes, namespaces, case, CSS — and get all of them right to be safe; a scanner
 * that only says yes to a short, exact allow-list and no to every byte it cannot classify has nothing
 * to get wrong but the list. Whatever it accepts is stored exactly as written, so the bytes served are
 * the bytes that were checked.
 *
 * `sniffImageType` is not taught SVG on purpose. It guards `upload` and `AttachmentService`, where
 * bytes arrive with no scanner in front of them; an SVG may only be stored through `sanitiseSvg`.
 *
 * This file depends on nothing else in the chat module, so the tool that calls it can import it
 * without closing a cycle through `chat.service.ts`.
 */

/** What a created image may be stored as: the four sniffed raster types, or SVG that passed {@link sanitiseSvg}. */
export type CreatedImageType = AttachmentImageType | 'image/svg+xml';

/** The longest SVG source taken, as UTF-8, checked before any scanning. */
export const MAX_CREATED_SVG_BYTES = 1 * 1024 * 1024;

/** The largest created raster image, measured after decoding. */
export const MAX_CREATED_IMAGE_BYTES = 2 * 1024 * 1024;

/** The most images one turn may create. Matches `MAX_IMAGES_PER_MESSAGE` in `chat.service.ts`, not imported to avoid a cycle. */
export const MAX_CREATED_IMAGES_PER_TURN = 5;

export type SanitisedSvg = { ok: true; bytes: Buffer } | { ok: false; reason: string };
export type DecodedImage = { ok: true; bytes: Buffer; contentType: AttachmentImageType } | { ok: false; reason: string };

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

const ALLOWED_ELEMENTS = new Set([
    'svg',
    'g',
    'defs',
    'title',
    'desc',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'marker',
    'symbol',
    'use',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'pattern',
]);

const ALLOWED_ATTRIBUTES = new Set([
    // Identity and accessibility
    'id',
    'role',
    'aria-label',
    'version',
    // Geometry
    'viewBox',
    'preserveAspectRatio',
    'width',
    'height',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'fx',
    'fy',
    'dx',
    'dy',
    'd',
    'points',
    'transform',
    // Paint
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-dasharray',
    'stroke-dashoffset',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'opacity',
    'clip-path',
    'clip-rule',
    'mask',
    // Markers, gradients, patterns
    'marker-start',
    'marker-mid',
    'marker-end',
    'markerWidth',
    'markerHeight',
    'markerUnits',
    'refX',
    'refY',
    'orient',
    'offset',
    'stop-color',
    'stop-opacity',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'patternUnits',
    'patternTransform',
    'patternContentUnits',
    'clipPathUnits',
    'maskUnits',
    'maskContentUnits',
    // Text
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
]);

/** Elements with a sentence of their own, keyed by lower-cased local name so `<SCRIPT>` and `<svg:script>` get it too. */
const REFUSED_ELEMENTS: Record<string, string> = {
    script: 'the SVG contains a <script> element, which could run code',
    style: 'the SVG contains a <style> element; styling must use the allowed presentation attributes',
    foreignobject: 'the SVG contains a <foreignObject> element, which embeds HTML',
    set: 'the SVG contains a <set> element; animation is not allowed',
    handler: 'the SVG contains a <handler> element, which could run code',
    image: 'the SVG contains an <image> element, which loads another file',
};

const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const URL_FRAGMENT = /url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)/gi;
const XML_DECLARATION =
    /^<\?xml[ \t\r\n]+version=(?:"1\.[0-9]"|'1\.[0-9]')(?:[ \t\r\n]+encoding=(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[ \t\r\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/;
const WHITESPACE = /^[ \t\r\n]*$/;

/** Sticky, so each is tried exactly where the scanner stands without copying the rest of the source. */
const TEXT_ENTITY_AT = /&(?:amp|lt|gt|quot|apos);/y;
const NAME_AT = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const ATTRIBUTE_AT = /([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/y;
const CLOSING_TAG_AT = /<\/([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*>/y;

const matchAt = (pattern: RegExp, source: string, at: number): RegExpExecArray | null => {
    pattern.lastIndex = at;
    return pattern.exec(source);
};

/** True for a control character XML forbids, a noncharacter, or half of a surrogate pair with no other half. */
const hasUnclassifiableCharacter = (source: string): boolean => {
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
        if (code === 0xfffe || code === 0xffff) return true;
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = source.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
};

const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\r' || char === '\n';

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Why `name` may not be an element, or `undefined` if it may. */
const elementRefusal = (name: string): string | undefined => {
    const local = (name.split(':').pop() ?? name).toLowerCase();
    const named = REFUSED_ELEMENTS[local];
    if (named) return named;
    if (local.startsWith('animate')) return `the SVG contains an <${name}> element; animation is not allowed`;
    if (!ALLOWED_ELEMENTS.has(name)) return `the SVG contains a <${name}> element, which is not on the allowed list`;
    return undefined;
};

/** Why `name="value"` may not appear on this element, or `undefined` if it may. */
const attributeRefusal = (element: string, name: string, value: string, isRoot: boolean): string | undefined => {
    if (name.toLowerCase().startsWith('on')) return `the SVG has an event handler attribute (${name}) on <${element}>, which could run code`;
    if (name.toLowerCase() === 'style') return `the SVG has a style attribute on <${element}>; styling must use the allowed presentation attributes`;
    if (value.includes('&')) return `the ${name} attribute on <${element}> contains "&"; attribute values may not use character or entity references`;
    if (value.includes('\\')) return `the ${name} attribute on <${element}> contains a backslash; attribute values may not use escapes`;

    // Control characters are refused before scanning, so whitespace is all a browser could skip inside a scheme.
    const squashed = value.toLowerCase().replace(/\s+/g, '');
    if (squashed.includes('javascript:')) return `the ${name} attribute on <${element}> contains "javascript:"`;
    if (squashed.includes('data:')) return `the ${name} attribute on <${element}> contains "data:"`;

    if (name === 'xmlns') {
        if (!isRoot) return `the SVG declares xmlns on <${element}>; it is allowed only on the root <svg>`;
        if (value !== SVG_NAMESPACE) return `the SVG declares xmlns="${value}"; only "${SVG_NAMESPACE}" is allowed`;
        return undefined;
    }
    if (name === 'xmlns:xlink') {
        if (!isRoot) return `the SVG declares xmlns:xlink on <${element}>; it is allowed only on the root <svg>`;
        if (value !== XLINK_NAMESPACE) return `the SVG declares xmlns:xlink="${value}"; only "${XLINK_NAMESPACE}" is allowed`;
        return undefined;
    }
    if (name.startsWith('xmlns')) return `the SVG declares the namespace ${name}, which is not allowed`;

    if (name === 'href' || name === 'xlink:href') {
        if (!FRAGMENT.test(value)) return `the ${name} on <${element}> points outside the document; only a bare #fragment is allowed`;
        return undefined;
    }

    if (!ALLOWED_ATTRIBUTES.has(name)) return `the SVG has a ${name} attribute on <${element}>, which is not on the allowed list`;

    if (/url[\s]*\(/i.test(value.replace(URL_FRAGMENT, ''))) {
        return `the ${name} attribute on <${element}> uses url(...) with something other than a #fragment in the document`;
    }
    return undefined;
};

/** Why the text run `text` may not appear, or `undefined` if it may. */
const textRefusal = (text: string): string | undefined => {
    for (let at = text.indexOf('&'); at !== -1; at = text.indexOf('&', at + 1)) {
        if (!matchAt(TEXT_ENTITY_AT, text, at))
            return 'the SVG text uses an entity or character reference other than &amp; &lt; &gt; &quot; or &apos;';
    }
    if (text.includes(']]>')) return 'the SVG text contains "]]>"';
    return undefined;
};

/**
 * `source` as UTF-8 bytes if it is an SVG made only of allowed elements and attributes, or the first
 * reason it is not. Nothing is ever rewritten: the bytes returned are `source`, unchanged.
 */
export const sanitiseSvg = (source: string): SanitisedSvg => {
    const byteLength = Buffer.byteLength(source, 'utf8');
    if (byteLength > MAX_CREATED_SVG_BYTES) return refuse(`the SVG is ${byteLength} bytes, over the ${MAX_CREATED_SVG_BYTES}-byte limit`);
    if (hasUnclassifiableCharacter(source)) return refuse('the SVG contains a control character or a broken character');

    const stack: string[] = [];
    let seenRoot = false;
    let at = 0;

    const declaration = XML_DECLARATION.exec(source);
    if (declaration) at = declaration[0].length;

    while (at < source.length) {
        if (source[at] !== '<') {
            const next = source.indexOf('<', at);
            const text = source.slice(at, next === -1 ? source.length : next);
            if (stack.length === 0) {
                if (!WHITESPACE.test(text)) return refuse('the SVG has text outside its <svg> element');
            } else {
                const reason = textRefusal(text);
                if (reason) return refuse(reason);
            }
            at += text.length;
            continue;
        }

        const rest = source.slice(at, at + 16);
        if (rest.startsWith('<!--')) return refuse('the SVG contains a comment');
        if (rest.startsWith('<![CDATA[')) return refuse('the SVG contains a CDATA section');
        if (rest.toUpperCase().startsWith('<!DOCTYPE')) return refuse('the SVG contains a <!DOCTYPE> declaration');
        if (rest.toUpperCase().startsWith('<!ENTITY')) return refuse('the SVG contains an <!ENTITY> declaration');
        if (rest.startsWith('<!')) return refuse('the SVG contains a markup declaration');
        if (rest.startsWith('<?')) return refuse('the SVG contains a processing instruction; only one leading <?xml ...?> is allowed');

        if (rest.startsWith('</')) {
            const closing = matchAt(CLOSING_TAG_AT, source, at);
            if (!closing) return refuse('the SVG has a malformed closing tag');
            const name = closing[1]!;
            const open = stack.pop();
            if (open !== name)
                return refuse(
                    open
                        ? `the SVG closes </${name}> where <${open}> is open; tags must balance`
                        : `the SVG closes </${name}>, which was never opened`,
                );
            at += closing[0].length;
            continue;
        }

        const nameMatch = matchAt(NAME_AT, source, at + 1);
        if (!nameMatch) return refuse('the SVG has a "<" that does not start a tag');
        const name = nameMatch[0];
        const refused = elementRefusal(name);
        if (refused) return refuse(refused);

        const isRoot = stack.length === 0;
        if (isRoot) {
            if (seenRoot) return refuse('the SVG has more than one root element');
            if (name !== 'svg') return refuse(`the SVG's root element is <${name}>, not <svg>`);
            seenRoot = true;
        }
        at += 1 + name.length;

        const seen = new Set<string>();
        for (;;) {
            const before = at;
            while (isSpace(source[at])) at++;
            if (source.startsWith('/>', at)) {
                at += 2;
                break;
            }
            if (source[at] === '>') {
                at += 1;
                stack.push(name);
                break;
            }
            if (at === before) return refuse(`the SVG has a malformed <${name}> tag`);
            const attribute = matchAt(ATTRIBUTE_AT, source, at);
            if (!attribute) return refuse(`the SVG has a malformed attribute on <${name}>`);
            const attributeName = attribute[1]!;
            const value = attribute[2] ?? attribute[3] ?? '';
            if (seen.has(attributeName)) return refuse(`the SVG repeats the ${attributeName} attribute on <${name}>`);
            seen.add(attributeName);
            const reason = attributeRefusal(name, attributeName, value, isRoot);
            if (reason) return refuse(reason);
            at += attribute[0].length;
        }
    }

    if (!seenRoot) return refuse('the source has no <svg> element');
    if (stack.length > 0) return refuse(`the SVG leaves <${stack[stack.length - 1]}> unclosed; tags must balance`);
    return { ok: true, bytes: Buffer.from(source, 'utf8') };
};

/** The longest base64 string that could decode within {@link MAX_CREATED_IMAGE_BYTES}. */
const MAX_CREATED_IMAGE_BASE64_LENGTH = Math.ceil(MAX_CREATED_IMAGE_BYTES / 3) * 4;

/**
 * `base64` decoded, if it is canonical padded base64 of a PNG, JPEG, WebP or GIF within
 * {@link MAX_CREATED_IMAGE_BYTES}. Strict by re-encoding: whitespace, URL-safe letters, missing
 * padding or stray characters all fail the comparison. The type comes from the bytes alone.
 */
export const decodeCreatedImage = (base64: string): DecodedImage => {
    if (base64.length === 0) return refuse('the image is empty');
    if (base64.length > MAX_CREATED_IMAGE_BASE64_LENGTH) return refuse(`the image is over the ${MAX_CREATED_IMAGE_BYTES}-byte limit`);

    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) return refuse('the image is not valid base64');
    if (bytes.length > MAX_CREATED_IMAGE_BYTES) return refuse(`the image is ${bytes.length} bytes, over the ${MAX_CREATED_IMAGE_BYTES}-byte limit`);

    const contentType = sniffImageType(bytes);
    if (!contentType) {
        if (/^\s*</.test(bytes.subarray(0, 64).toString('utf8'))) {
            return refuse('the bytes are markup, not a PNG, JPEG, WebP or GIF image; an SVG must be sent as source so it can be checked');
        }
        return refuse("the image's bytes are not a PNG, JPEG, WebP or GIF image");
    }
    return { ok: true, bytes, contentType };
};
