import { useId } from 'react';

export interface WilsonMarkProps {
    /** Pixel size, applied to both width and height. Below 24 this switches to the hinted
     * `wilson-mark-16.svg` geometry — `brand/README.md` says never to scale the primary mark
     * smaller than that. */
    size?: number;
}

/** The four-spike tuft and head outline shared by every mark and every state face
 * (`brand/wilson-mark.svg`, `brand/states/*.svg`) — one `<g>`, reused by both geometries below and
 * by `StateIcon`, so the head itself only ever needs to change in one place. */
function PrimaryHead() {
    return (
        <g fill="white">
            <rect x="22" y="22" width="12" height="30" rx="6" transform="rotate(-11 28 37)" />
            <rect x="36.5" y="15" width="12" height="37" rx="6" transform="rotate(-4 42.5 33)" />
            <rect x="51" y="17" width="12" height="35" rx="6" transform="rotate(4 57 34)" />
            <rect x="65.5" y="24" width="12" height="28" rx="6" transform="rotate(11 71.5 38)" />
            <path d="M16 40 h68 a10 10 0 0 1 10 10 v9 a34 34 0 0 1 -34 34 h-20 a34 34 0 0 1 -34 -34 v-9 a10 10 0 0 1 10 -10 z" />
        </g>
    );
}

/** The "passed" face — two checks and a smile — is `wilson-mark.svg`'s own face: the brand mark is
 * not a distinct seventh drawing, it is the "all clear" state worn as the default identity. */
function PrimaryFace() {
    return (
        <g fill="none" stroke="black" strokeWidth="5.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M28 61 l5 5 l9 -12" />
            <path d="M61 61 l5 5 l9 -12" />
            <path d="M34 77 q16 12 32 0" />
        </g>
    );
}

function HintedHead() {
    return (
        <g fill="white">
            <rect x="17" y="28" width="18" height="24" rx="9" />
            <rect x="38" y="21" width="18" height="31" rx="9" />
            <rect x="59" y="25" width="18" height="27" rx="9" />
            <path d="M10 40 h80 a10 10 0 0 1 10 10 v7 a40 40 0 0 1 -40 40 h-20 a40 40 0 0 1 -40 -40 v-7 a10 10 0 0 1 10 -10 z" />
        </g>
    );
}

function HintedFace() {
    return (
        <g fill="none" stroke="black" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round">
            <path d="M29 62 l4 4 l8 -10" />
            <path d="M61 62 l4 4 l8 -10" />
            <path d="M36 80 q14 9 28 0" />
        </g>
    );
}

/**
 * Inlined `brand/wilson-mark.svg`, switching to `brand/wilson-mark-16.svg`'s heavier geometry below
 * 24px (this card's Constraints) — `currentColor` fills, so it takes the surrounding text color the
 * way the brand guide requires (`brand/README.md`: "one colour only").
 *
 * `brand/README.md`'s own note: the source files' `<mask>` ids (`wilson-mark` / `wilson-16`) are
 * meant to be unique per page. Two instances embedded verbatim would collide and one would silently
 * pick up the other's shape — `useId()` mints a fresh id per rendered instance instead, so this is
 * safe wherever more than one `WilsonMark` renders on the same page.
 */
export function WilsonMark({ size = 24 }: WilsonMarkProps) {
    const maskId = `wilson-mark-${useId()}`;
    const hinted = size < 24;

    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width={size} height={size} role="img" aria-label="Wilson">
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
                <rect width="100" height="100" fill="black" />
                {hinted ? <HintedHead /> : <PrimaryHead />}
                {hinted ? <HintedFace /> : <PrimaryFace />}
            </mask>
            <rect width="100" height="100" fill="currentColor" mask={`url(#${maskId})`} />
        </svg>
    );
}
