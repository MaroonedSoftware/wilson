import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import type { Logger } from '@maroonedsoftware/logger';

/**
 * Whether `checkWebhookDestination` is willing to let this daemon contact a URL, and why not when
 * it isn't.
 *
 * `reason` names both the rule that was broken and the address (or hostname, or scheme) that broke
 * it (card 0107's Constraints: "A refused URL must say why, specifically") — never a bare "invalid
 * webhook URL", which tells an operator nothing they can act on.
 */
export type WebhookDestinationCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Judges a webhook URL against the rules card 0107 exists to enforce, resolving the host the same
 * way the eventual `fetch()` call would rather than trusting the string alone — a hostname that
 * resolves to a private address defeats a literal-only check exactly as easily as a redirect does.
 *
 * Called twice, on purpose, from two different places: `NotifyWebhookSettingService` (write time,
 * to give an operator an immediate error) and `Notifier.notify` (use time, on every send). DNS
 * answers change between the two — a name that resolves to a public address on Tuesday can resolve
 * to `169.254.169.254` on Wednesday with the stored URL never having changed — so the write-time
 * call is a courtesy, not the guarantee; the use-time call is what actually protects anything.
 *
 * ## What this stops
 *
 * - Anything that is not `https`: a plaintext webhook would carry card titles and stage outcomes
 *   off the machine in the clear, which is not worth the convenience of allowing `http`.
 * - A hostname (or literal address) that resolves to loopback, link-local (including the cloud
 *   metadata address `169.254.169.254`), a private, shared (carrier-grade NAT) or reserved range, or
 *   an unspecified address, or to an IPv6 form that carries one of those (IPv4-mapped, NAT64, 6to4).
 *   Every address `dns.lookup(..., { all: true })` returns is checked, not just the first —
 *   `fetch()` is free to connect to any of them.
 * - A URL that fails to parse at all.
 *
 * Redirects are a `Notifier`-level decision, not this function's: an HTTP redirect is only visible
 * once a request is actually made, which is not a "check", so `Notifier.notify` sends with
 * `redirect: 'manual'` and refuses to follow one rather than asking this function to fetch anything.
 *
 * ## What this does not stop
 *
 * This narrows *where* the server can be pointed. It does not stop an unauthenticated caller
 * pointing it somewhere this check still allows — a public address the caller controls, say — and
 * having this daemon POST a card's title and stage outcome there. `routes.setup.ts` already says
 * plainly that this server has no authentication and no sessions at all (card 0019); as long as
 * that stands, anything that can reach this API can set (or already find configured) any webhook
 * URL this check permits. Authenticating the API is the actual answer; this is mitigation on an
 * unauthenticated surface, not a substitute for it.
 *
 * It is also not airtight against the exact DNS-rebinding threat it is aimed at: the check and the
 * `fetch()` that follows it in `Notifier.notify` are two separate lookups, not one atomic operation,
 * so an adversary controlling the DNS answer could in principle change it in the narrow window
 * between them. Re-checking on every send (rather than trusting a value validated once, at write)
 * closes the practical version of that gap — the window left is a single resolver round trip, not
 * the days or weeks an unvalidated setting would otherwise sit unrefreshed — but a real guarantee
 * here would mean resolving once and connecting to that exact address, which `fetch()` gives this
 * codebase no way to do.
 */
export async function checkWebhookDestination(rawUrl: string): Promise<WebhookDestinationCheck> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { ok: false, reason: `"${rawUrl}" is not a valid URL` };
    }

    if (parsed.protocol !== 'https:') {
        return { ok: false, reason: `webhook URL must use https, not "${parsed.protocol.replace(/:$/, '')}"` };
    }

    // `URL#hostname` keeps the square brackets around an IPv6 literal (`new URL('https://[::1]/').
    // hostname === '[::1]'`) — `dns.lookup` does not accept that notation and rejects it as
    // ENOTFOUND, which without this stripping would fall into the "does not resolve, so not this
    // function's problem" branch below and let an operator-supplied IPv6 loopback/link-local/private
    // literal straight through the very check this function exists to run.
    const lookupHost = parsed.hostname.replace(/^\[(.*)\]$/, '$1');

    let addresses: { address: string; family: number }[];
    try {
        addresses = await lookup(lookupHost, { all: true });
    } catch {
        // A hostname that does not resolve at all is not one of the addresses this function
        // exists to reject — it is broken, not dangerous, and the `fetch()` call `Notifier.notify`
        // makes right after this will fail on exactly the same lookup and be caught, logged and
        // swallowed there the same way any other network failure already is. Refusing it here too
        // would just duplicate that path with a different message.
        return { ok: true };
    }

    for (const { address } of addresses) {
        const rule = disallowedAddressRule(address);
        if (rule) {
            return { ok: false, reason: `"${parsed.hostname}" resolves to a ${rule} address (${address})` };
        }
    }

    return { ok: true };
}

/**
 * The one rule an address breaks, or `undefined` if it breaks none of them.
 *
 * Checked against every address a hostname resolves to (`checkWebhookDestination`), not just
 * whichever `fetch()` happens to pick.
 */
function disallowedAddressRule(address: string): string | undefined {
    if (isIPv4(address)) return disallowedIPv4Rule(address);
    if (isIPv6(address)) return disallowedIPv6Rule(address);
    return 'unresolvable';
}

function disallowedIPv4Rule(address: string): string | undefined {
    const octets = address.split('.').map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    const c = octets[2] ?? -1;
    if (a === 0) return 'unspecified';
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    // 100.64.0.0/10: carrier-grade NAT, which is also where Tailscale puts a tailnet's machines.
    if (a === 100 && b >= 64 && b <= 127) return 'shared';
    // 192.0.0.0/24: IETF protocol assignments, some of which (DS-Lite, NAT64 discovery) are local.
    if (a === 192 && b === 0 && c === 0) return 'reserved';
    // 198.18.0.0/15: benchmarking, routinely used as private space inside a network.
    if (a === 198 && (b === 18 || b === 19)) return 'reserved';
    return undefined;
}

function disallowedIPv6Rule(address: string): string | undefined {
    const groups = ipv6Groups(address);
    if (!groups) return 'unresolvable';
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    const embedded = (hi: number, lo: number) => disallowedIPv4Rule(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    const zeroesTo = (end: number) => groups.slice(0, end).every(group => group === 0);

    if (zeroesTo(7) && g7 === 1) return 'loopback';
    if (zeroesTo(8)) return 'unspecified';
    // fe80::/10, whose second hex digit runs 8 to b, not only the fe80: everyone writes.
    if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
    // fc00::/7: unique local addresses, IPv6's rough counterpart to the IPv4 private ranges.
    if ((g0 & 0xfe00) === 0xfc00) return 'private';
    // Forms that carry an IPv4 address, judged as that address. ::ffff:0:0/96 is IPv4-mapped, and
    // ::/96 the deprecated IPv4-compatible form, so a dotted literal and a hex DNS answer agree.
    if (zeroesTo(5) && g5 === 0xffff) return embedded(g6, g7);
    if (zeroesTo(6)) return embedded(g6, g7);
    // 64:ff9b::/96 is the well-known NAT64 prefix, and 64:ff9b:1::/48 the local-use one, whose
    // translator is the operator's own, so any address behind it is treated as reaching inside.
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return 'private';
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
    // 2002::/16 is 6to4, whose next 32 bits are the IPv4 address of the far end.
    if (g0 === 0x2002) return embedded(g1, g2);
    return undefined;
}

/**
 * The eight 16-bit groups of an IPv6 address, or `undefined` for one `isIPv6` accepted that this
 * cannot read. Read as numbers rather than matched as text because the same address has many
 * spellings (`0:0:0:0:0:ffff:7f00:1`, `::ffff:127.0.0.1`, `::FFFF:7F00:1`), and a prefix check on
 * any one of them misses the others. A zone (`fe80::1%en0`) names an interface, not an address.
 */
function ipv6Groups(address: string): number[] | undefined {
    const unzoned = address.toLowerCase().split('%')[0] ?? '';
    const dotted = unzoned.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    const text = dotted
        ? `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}`
        : unzoned;

    const [head = '', tail] = text.split('::');
    const parse = (part: string) => (part ? part.split(':').map(group => Number.parseInt(group, 16)) : []);
    const left = parse(head);
    const right = parse(tail ?? '');
    const groups = tail === undefined ? left : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
    return groups.length === 8 && groups.every(group => Number.isInteger(group)) ? groups : undefined;
}

/** Last reason logged for a given URL, so a value that keeps failing the same way is not re-logged
 * on every call — shared by `Notifier.notify` (one call per notification) and
 * `NotifyWebhookSettingService.applyCurrentValue` (one call per write, plus once at boot), the two
 * places an invalid stored value is discovered. Module-level rather than per-instance: `Notifier` is
 * constructed fresh for every notification (it is not DI-managed — see its own doc), so instance
 * state would never survive between calls. */
const lastLoggedReason = new Map<string, string>();

/**
 * Log an invalid webhook's reason once, not on every call that discovers it — card 0107's Task 3:
 * "an invalid stored value must behave like unset with a logged reason, never like a failure that
 * interferes with a card", logged once rather than per notification.
 *
 * Keyed by the URL itself so a change to the stored value — a different reason, or the same
 * reason for a new URL — logs again; the same URL failing the same way repeatedly does not.
 */
export function warnOnceInvalidWebhook(logger: Logger, url: string, reason: string): void {
    if (lastLoggedReason.get(url) === reason) return;
    lastLoggedReason.set(url, reason);
    logger.warn(`notify webhook disabled: ${reason}`);
}
