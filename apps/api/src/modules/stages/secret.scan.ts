import type { AddedLine } from '#modules/worktree/added.lines.js';

/** The credential kinds this scan knows. A finding names one of these and never the value. */
export type SecretKind = 'private key' | 'GitHub token' | 'AWS access key' | 'Anthropic API key' | 'OpenAI API key';

/**
 * Where a credential landed. Deliberately has no field for the match: these reach events, card bodies
 * and notifications, and a type with nowhere to put the value cannot leak it.
 */
export interface SecretFinding {
    path: string;
    line: number;
    kind: SecretKind;
}

/** `prefix` is the fixed part of the format, which says nothing about whether the rest is random. */
const TOKEN_PATTERNS: { kind: SecretKind; pattern: RegExp; prefix: RegExp }[] = [
    {
        kind: 'GitHub token',
        pattern: /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9]{20,}_[A-Za-z0-9]{40,})/g,
        prefix: /^(?:gh[pousr]|github_pat)_/,
    },
    { kind: 'AWS access key', pattern: /(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[A-Z2-7]{16}(?![A-Za-z0-9_-])/g, prefix: /^(?:AKIA|ASIA)/ },
    { kind: 'Anthropic API key', pattern: /(?<![A-Za-z0-9_-])sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{40,}/g, prefix: /^sk-ant-[a-z]+[0-9]*-/ },
    {
        kind: 'OpenAI API key',
        pattern: /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})/g,
        prefix: /^sk-(?:(?:proj|svcacct|admin)-)?/,
    },
];

const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_BODY = /[A-Za-z0-9+/]{40,}/;
/** Far enough to step over a legacy PEM's `Proc-Type` and `DEK-Info` headers and the blank line after them. */
const PRIVATE_KEY_BODY_REACH = 4;

/**
 * Words a random credential rarely holds by chance: a few keys in 10,000 would contain one of these,
 * and the real key this skips costs less than flagging every fixture written this way.
 */
const PLACEHOLDER = /example|placeholder|dummy|fake|sample|redacted|your|test|xxxx/i;
/** Below this many bits per character, a value is a pattern and not a key. */
const MIN_ENTROPY_BITS = 3;
const MAX_ASCENDING_RUN = 7;

const entropyBits = (value: string): number => {
    const counts = new Map<string, number>();
    for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
        const share = count / value.length;
        bits -= share * Math.log2(share);
    }
    return bits;
};

/** `12345678` and `abcdefgh`: what a person types when they want something the right shape. */
const hasAscendingRun = (value: string): boolean => {
    let run = 1;
    for (let index = 1; index < value.length; index++) {
        run = value.charCodeAt(index) === value.charCodeAt(index - 1) + 1 ? run + 1 : 1;
        if (run > MAX_ASCENDING_RUN) return true;
    }
    return false;
};

const looksRandom = (value: string): boolean => !PLACEHOLDER.test(value) && entropyBits(value) >= MIN_ENTROPY_BITS && !hasAscendingRun(value);

const holdsKeyBody = (text: string): boolean => {
    const body = PRIVATE_KEY_BODY.exec(text.replaceAll('\\n', ' '))?.[0];
    return body !== undefined && looksRandom(body);
};

/**
 * A `BEGIN PRIVATE KEY` header on its own is ordinary code: parsers, regexes, documentation. Only a
 * body of key material after it makes it a key, on the same line for an escaped PEM in a string, or on
 * the added lines straight below it for a real one.
 */
const isPrivateKey = (lines: AddedLine[], index: number): boolean => {
    const current = lines[index]!;
    const header = PRIVATE_KEY_HEADER.exec(current.text);
    if (!header) return false;
    if (holdsKeyBody(current.text.slice(header.index + header[0].length))) return true;

    for (let next = index + 1; next < lines.length && next <= index + PRIVATE_KEY_BODY_REACH; next++) {
        const candidate = lines[next]!;
        if (candidate.line !== current.line + (next - index)) return false;
        if (holdsKeyBody(candidate.text)) return true;
    }
    return false;
};

/**
 * The credentials in one file's added lines. Pure, so that reading the diff, which may happen on
 * another machine, stays with the caller. High-confidence formats only: each has a fixed shape and
 * must then look random, because a check that cries wolf gets declared around.
 */
export const scanAddedLines = (path: string, lines: AddedLine[]): SecretFinding[] => {
    const findings: SecretFinding[] = [];
    lines.forEach((added, index) => {
        if (isPrivateKey(lines, index)) findings.push({ path, line: added.line, kind: 'private key' });
        for (const { kind, pattern, prefix } of TOKEN_PATTERNS) {
            const real = [...added.text.matchAll(pattern)].some(([match]) => looksRandom(match.replace(prefix, '')));
            if (real) findings.push({ path, line: added.line, kind });
        }
    });
    return findings;
};
