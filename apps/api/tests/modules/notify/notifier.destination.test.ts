import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier } from '#modules/notify/notifier.js';
import type { CardNotification } from '#modules/notify/notification.js';
import type { Logger } from '@maroonedsoftware/logger';

const fakeLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

const notification = (overrides: Partial<CardNotification> = {}): CardNotification => ({
    project: 'wilson',
    cardId: '0107',
    title: 'The webhook becomes a setting',
    stage: 'review',
    moment: 'manual',
    ...overrides,
});

/**
 * Card 0107 gave `Notifier.notify` a destination check (`checkWebhookDestination`) it runs on every
 * call, and a `redirect: 'manual'` fetch that refuses to follow a 3xx instead of chasing it. Both are
 * new behaviour `notifier.test.ts` (which predates this card) never exercises — these tests cover it
 * directly, using literal IP addresses so the destination check resolves deterministically without
 * any real DNS query.
 */
describe('Notifier, destination checking (card 0107)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('a destination the check refuses', () => {
        it('does not POST, and logs the reason, when the webhook resolves to a private address', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await new Notifier('https://10.1.2.3/notify', undefined, logger).notify(notification());

            expect(fetchMock).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain('private');
            expect(logger.warn.mock.calls[0][0]).toContain('10.1.2.3');
        });

        it('does not POST, and logs the reason, when the webhook resolves to loopback', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await new Notifier('https://127.0.0.1/notify', undefined, logger).notify(notification());

            expect(fetchMock).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain('loopback');
        });

        it('does not POST an http webhook — https-only is enforced on every send, not just at write', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await new Notifier('http://example.com/notify', undefined, logger).notify(notification());

            expect(fetchMock).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain('https');
        });

        it('does not throw when the destination is refused — behaves like no webhook configured, not like a failure', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            await expect(new Notifier('https://169.254.169.254/notify', undefined, fakeLogger()).notify(notification())).resolves.toBeUndefined();
        });
    });

    describe('a destination the check allows', () => {
        it('still POSTs the same payload it always did, to a webhook resolving to a public address', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);

            await new Notifier('https://93.184.216.34/notify', undefined, fakeLogger()).notify(notification({ cardId: '0072', title: 'a card' }));

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('https://93.184.216.34/notify');
            expect(JSON.parse(init.body as string)).toEqual({
                moment: 'manual',
                project: 'wilson',
                cardId: '0072',
                title: 'a card',
                stage: 'review',
            });
        });

        it('sends with redirect: "manual" rather than letting fetch follow one automatically', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);

            await new Notifier('https://93.184.216.34/notify', undefined, fakeLogger()).notify(notification());

            const init = fetchMock.mock.calls[0][1];
            expect(init.redirect).toBe('manual');
        });
    });

    describe('a redirect response', () => {
        it('logs a warning and does not treat it as success, when the server answers with a redirect', async () => {
            // `redirect: 'manual'` makes `fetch` resolve a 3xx as an opaque redirect response rather
            // than following it — this is what that response shape looks like from `notify`'s
            // point of view.
            const opaqueRedirect = { type: 'opaqueredirect', ok: false, status: 0 } as unknown as Response;
            const fetchMock = vi.fn(async () => opaqueRedirect);
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await new Notifier('https://93.184.216.34/notify', undefined, logger).notify(notification({ cardId: '0072', moment: 'manual' }));

            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain('0072');
            expect(logger.warn.mock.calls[0][0]).toContain('redirect');
        });
    });
});
