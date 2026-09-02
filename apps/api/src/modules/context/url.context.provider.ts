import { createHash } from 'node:crypto';
import { checkWebhookDestination, type WebhookDestinationCheck } from '#modules/notify/webhook.destination.js';
import type { ContextFetchResult, ContextProvider } from './context.provider.js';

/** How long a fetch waits before it is abandoned. Follows `NOTIFY_TIMEOUT_MS`'s shape
 * (`#modules/notify/notifier.js`) — a document fetch deserves more than a webhook POST does, but it
 * deserves a number, not an unbounded wait. */
const FETCH_TIMEOUT_MS = 15_000;

/** How many bytes of response body this provider will read before refusing the rest. Enforced while
 * reading, not after — `await response.text()` on an unbounded body is how a daemon runs out of
 * memory because someone pasted a link to a disk image. */
const MAX_CONTENT_BYTES = 2_000_000;

/**
 * Fetches a plain `https` URL and normalises it to the plain text `ContextFetchResult` stores.
 *
 * What this does *not* do: it is not an HTML-to-Markdown converter. It decodes the response body as
 * text and trims it — nothing about structure, links, or formatting survives that a real HTML
 * extractor would preserve. A provider that wants structure (or a title pulled out of a `<title>`
 * tag) is a later card; this one's job is the seam and the safety, not the parsing.
 *
 * ## Constructor dependencies, not module-level defaults
 *
 * `checkDestination` and `fetchImpl` are constructor parameters, defaulting to the real
 * `checkWebhookDestination` and the global `fetch`, because this is the only way the card is testable
 * at all (card 0186's Constraints): the real check refuses loopback, so a test cannot point a real
 * provider at a stub server on `127.0.0.1`. With both injected, the refusal paths are tested against
 * the real check and the normalisation/bounds paths against an injected stub, without either test
 * needing the other's machinery. `timeoutMs` and `maxContentBytes` are injectable for the same
 * reason — a test proving the timeout and size-cap behavior needs both to be small, not the
 * production numbers above.
 *
 * ## Reuse, not reimplementation, of the SSRF check
 *
 * A daemon fetching an operator-supplied URL is the same threat card 0107 already solved for a daemon
 * *POSTing* to one: `checkWebhookDestination` resolves the host and refuses loopback, link-local
 * (including the cloud metadata address), private ranges, unspecified addresses, anything not
 * `https`, and anything unparseable — checking every address a hostname resolves to, not just the
 * first. It is called here on every `fetch`, never cached, for the same reason `Notifier.notify` calls
 * it on every send: a hostname that resolves publicly today can resolve to a private address tomorrow
 * with the URL never having changed, so the use-time call is what actually protects anything (see that
 * function's own doc for the full reasoning and its limits).
 *
 * Redirects are refused, never followed, for the same reason `Notifier.notify` refuses them: a
 * destination check cannot see where a redirect goes, so a permitted URL that 302s to
 * `169.254.169.254` would defeat any amount of pre-checking. `fetchImpl` is called with
 * `redirect: 'manual'`, which turns a 3xx response into `type: 'opaqueredirect'` instead of following
 * it automatically.
 */
export class UrlContextProvider implements ContextProvider {
    constructor(
        private readonly checkDestination: (url: string) => Promise<WebhookDestinationCheck> = checkWebhookDestination,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly timeoutMs: number = FETCH_TIMEOUT_MS,
        private readonly maxContentBytes: number = MAX_CONTENT_BYTES,
    ) {}

    /** Accepts anything that parses as an `https` URL. The destination check — loopback, private
     * ranges, and the rest — happens in `fetch`, not here: `canHandle` is a cheap, synchronous
     * dispatch key for the registry, not a security boundary. */
    canHandle(url: string): boolean {
        try {
            return new URL(url).protocol === 'https:';
        } catch {
            return false;
        }
    }

    async fetch(url: string): Promise<ContextFetchResult> {
        const destination = await this.checkDestination(url);
        if (!destination.ok) {
            return { ok: false, reason: destination.reason };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(url, { redirect: 'manual', signal: controller.signal });

            if (response.type === 'opaqueredirect') {
                return { ok: false, reason: `"${url}" refused: server responded with a redirect, which is not followed` };
            }
            if (!response.ok) {
                return { ok: false, reason: `"${url}" returned ${response.status}` };
            }

            const read = await this.readBounded(response);
            if (!read.ok) {
                return { ok: false, reason: `"${url}" exceeds the ${this.maxContentBytes}-byte limit` };
            }

            const content = read.text.trim();
            const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
            return { ok: true, content, contentHash, fetchedAt: new Date() };
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                return { ok: false, reason: `fetching "${url}" timed out after ${this.timeoutMs}ms` };
            }
            return { ok: false, reason: `fetching "${url}" failed: ${(error as Error).message}` };
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Reads `response`'s body up to `maxContentBytes`, refusing (and cancelling the underlying
     * stream) the moment that cap is crossed rather than after the whole body has been buffered —
     * `await response.text()` has no such cap and would read an arbitrarily large body fully into
     * memory before this class ever got a chance to refuse it.
     */
    private async readBounded(response: Response): Promise<{ ok: true; text: string } | { ok: false }> {
        const reader = response.body?.getReader();
        if (!reader) return { ok: true, text: '' };

        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > this.maxContentBytes) {
                await reader.cancel();
                return { ok: false };
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { ok: true, text };
    }
}
