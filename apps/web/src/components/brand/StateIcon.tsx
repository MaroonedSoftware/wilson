import { useId, type ReactNode } from 'react';

/** Matches `brand/states/*.svg`'s six faces one-for-one — see `brand/README.md`'s States table for
 * what each means. Exported so a caller (a follow-up card wiring this onto Board tiles or
 * CardDetail — out of scope here) can type a card's state without redeclaring this union. */
export type CardState = 'parked' | 'running' | 'passed' | 'kicked-back' | 'needs-human' | 'poisoned';

export interface StateIconProps {
    state: CardState;
    /** Pixel size, applied to both width and height. */
    size?: number;
}

interface Face {
    /** Matches the source file's own `<title>` (`brand/states/*.svg`), so an inlined icon carries
     * the same accessible name the static asset would have. */
    label: string;
    strokeWidth: string;
    paths: ReactNode;
}

const FACES: Record<CardState, Face> = {
    parked: {
        label: 'Wilson — parked',
        strokeWidth: '6',
        paths: (
            <>
                <path d="M35 63 l0 1" />
                <path d="M65 63 l0 1" />
                <path d="M36 78 h28" />
            </>
        ),
    },
    running: {
        label: 'Wilson — running',
        strokeWidth: '5.4',
        paths: (
            <>
                <path d="M29 64 q6 -9 12 0" />
                <path d="M59 64 q6 -9 12 0" />
                <circle cx="50" cy="78" r="4.8" />
            </>
        ),
    },
    passed: {
        label: 'Wilson — passed',
        strokeWidth: '5.6',
        paths: (
            <>
                <path d="M28 61 l5 5 l9 -12" />
                <path d="M61 61 l5 5 l9 -12" />
                <path d="M34 77 q16 12 32 0" />
            </>
        ),
    },
    'kicked-back': {
        label: 'Wilson — kicked back',
        strokeWidth: '5.6',
        paths: (
            <>
                <path d="M29 63 h11" />
                <path d="M60 63 h11" />
                <path d="M34 82 q16 -12 32 0" />
            </>
        ),
    },
    'needs-human': {
        label: 'Wilson — needs human',
        strokeWidth: '5.4',
        paths: (
            <>
                <path d="M29 57 q6 -7 11 0 q2 5 -5.5 8" />
                <path d="M60 57 q6 -7 11 0 q2 5 -5.5 8" />
                <path d="M36 80 h28" />
            </>
        ),
    },
    poisoned: {
        label: 'Wilson — poisoned',
        strokeWidth: '5.4',
        paths: (
            <>
                <path d="M29 58 l10 10" />
                <path d="M39 58 l-10 10" />
                <path d="M61 58 l10 10" />
                <path d="M71 58 l-10 10" />
                <path d="M36 80 h28" />
            </>
        ),
    },
};

/**
 * Inlined `brand/states/*.svg`, one component for all six faces (`CardState`) instead of six —
 * every face shares the same head and only the face-mask paths differ (`brand/README.md`: "The face
 * is a slot"). No board or card-detail wiring here (out of scope — a follow-up card does that); this
 * is only the reusable icon those callers will render.
 *
 * `<mask>` ids in the source files are per-state, not per-instance (`wilson-parked`, `wilson-running`,
 * …), so two `StateIcon`s of the *same* state on one page would collide the way `brand/README.md`
 * warns about. `useId()` mints a fresh id per rendered instance regardless of state, the same fix
 * `WilsonMark` uses — asserted by this card's own tests.
 */
export function StateIcon({ state, size = 20 }: StateIconProps) {
    const reactId = useId();
    const maskId = `wilson-state-${state}-${reactId}`;
    const titleId = `wilson-state-title-${reactId}`;
    const face = FACES[state];

    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width={size} height={size} role="img" aria-labelledby={titleId}>
            <title id={titleId}>{face.label}</title>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
                <rect width="100" height="100" fill="black" />
                <g fill="white">
                    <rect x="22" y="22" width="12" height="30" rx="6" transform="rotate(-11 28 37)" />
                    <rect x="36.5" y="15" width="12" height="37" rx="6" transform="rotate(-4 42.5 33)" />
                    <rect x="51" y="17" width="12" height="35" rx="6" transform="rotate(4 57 34)" />
                    <rect x="65.5" y="24" width="12" height="28" rx="6" transform="rotate(11 71.5 38)" />
                    <path d="M16 40 h68 a10 10 0 0 1 10 10 v9 a34 34 0 0 1 -34 34 h-20 a34 34 0 0 1 -34 -34 v-9 a10 10 0 0 1 10 -10 z" />
                </g>
                <g fill="none" stroke="black" strokeWidth={face.strokeWidth} strokeLinecap="round" strokeLinejoin="round">
                    {face.paths}
                </g>
            </mask>
            <rect width="100" height="100" fill="currentColor" mask={`url(#${maskId})`} />
        </svg>
    );
}
