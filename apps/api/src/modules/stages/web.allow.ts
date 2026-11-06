/**
 * A project's `webAllow` list (card 0019): the hosts a stage may fetch pages from. Nothing reads this
 * to grant access yet — the guard that will is card 0020's — so this file is only the shape of an
 * entry and the one question the guard will ask of a URL.
 *
 * An entry is a bare hostname, optionally led by `*.` to mean "any subdomain of". No scheme, path,
 * port or whitespace: anything richer than a host would be a promise the matcher does not keep.
 */

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const ENTRY = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*$`, 'i');

/** Whether `entry` is a valid `webAllow` entry: `github.com` or `*.githubusercontent.com`. */
export const isWebAllowEntry = (entry: string): boolean => ENTRY.test(entry);

/**
 * Whether `url` is on a host `webAllow` names. Only http(s) URLs can be, and only their parsed
 * hostname is compared, so userinfo (`https://github.com@evil.com`) and lookalike suffixes
 * (`github.com.evil.com`) do not match `github.com`. `*.x.com` matches subdomains of `x.com`, not
 * `x.com` itself. Case-insensitive throughout; an empty list allows nothing.
 */
export const isHostAllowed = (url: string, webAllow: readonly string[]): boolean => {
    if (webAllow.length === 0) return false;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return false;

    return webAllow.some(raw => {
        if (!isWebAllowEntry(raw)) return false;
        const entry = raw.toLowerCase();
        if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
        return host === entry;
    });
};
