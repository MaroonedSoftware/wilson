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
 *   metadata address `169.254.169.254`), a private range, or an unspecified address. Every address
 *   `dns.lookup(..., { all: true })` returns is checked, not just the first — `fetch()` is free to
 *   connect to any of them.
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

    let addresses: { address: string; family: number }[];
    try {
        addresses = await lookup(parsed.hostname, { all: true });
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
    if (isIPv4(address)) {
        if (address === '0.0.0.0') return 'unspecified';
        const octets = address.split('.').map(Number);
        const a = octets[0] ?? -1;
        const b = octets[1] ?? -1;
        if (a === 127) return 'loopback';
        if (a === 169 && b === 254) return 'link-local';
        if (a === 10) return 'private';
        if (a === 172 && b >= 16 && b <= 31) return 'private';
        if (a === 192 && b === 168) return 'private';
        return undefined;
    }

    if (isIPv6(address)) {
        const normalized = address.toLowerCase();
        if (normalized === '::1') return 'loopback';
        if (normalized === '::') return 'unspecified';
        if (normalized.startsWith('fe80:')) return 'link-local';
        // fc00::/7 — unique local addresses, IPv6's rough counterpart to the IPv4 private ranges.
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private';
        // An IPv4-mapped IPv6 address carries the same address under a different notation.
        const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped?.[1]) return disallowedAddressRule(mapped[1]);
        return undefined;
    }

    return 'unresolvable';
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
