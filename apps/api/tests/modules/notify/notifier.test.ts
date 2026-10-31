import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier, registerNotificationChannel } from '#modules/notify/notifier.js';
import type { CardNotification } from '#modules/notify/notification.js';
import type { Logger } from '@maroonedsoftware/logger';

// Captured before any test installs fake timers, so it stays the genuine, un-fake-able timer —
// used only to wait out `Notifier.notify`'s real DNS lookup (card 0107's `checkWebhookDestination`)
// in the one test below that mocks time.
const realSetTimeout = globalThis.setTimeout;

const fakeLogger = (): Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

const notification = (overrides: Partial<CardNotification> = {}): CardNotification => ({
    project: 'wilson',
    cardId: '0050',
    title: 'Nothing tells anyone the machine stopped',
    stage: 'review',
    moment: 'manual',
    ...overrides,
});

/**
 * Card 0050: `Notifier` is the whole of the runner's one notification channel — everything the
 * Notification section of PROJECT.md asks for funnels through this one `notify()` call. These are
 * unit tests of that class in isolation (the three call sites get their own integration coverage),
 * standing in for a real webhook with a stubbed `fetch`.
 */
describe('Notifier', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    describe('registered channels', () => {
        it('sends to a channel with no webhook configured', async () => {
            const send = vi.fn(async () => undefined);
            const remove = registerNotificationChannel({ name: 'test', send });

            await new Notifier(undefined, undefined, fakeLogger()).notify(notification());
            remove();

            expect(send).toHaveBeenCalledWith(notification());
        });

        it('keeps a failing channel from reaching the caller, the webhook or the next channel', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();
            const next = vi.fn(async () => undefined);
            const removeBroken = registerNotificationChannel({
                name: 'broken',
                send: async () => {
                    throw new Error('no route');
                },
            });
            const removeNext = registerNotificationChannel({ name: 'next', send: next });

            await expect(new Notifier('https://hooks.example/notify', undefined, logger).notify(notification())).resolves.toBeUndefined();
            removeBroken();
            removeNext();

            expect(next).toHaveBeenCalledOnce();
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('notify broken for 0050 (manual) failed: no route'));
        });

        it('stops sending once a channel is removed', async () => {
            const send = vi.fn(async () => undefined);
            registerNotificationChannel({ name: 'test', send })();

            await new Notifier(undefined, undefined, fakeLogger()).notify(notification());

            expect(send).not.toHaveBeenCalled();
        });
    });

    describe('off by default', () => {
        it('makes no HTTP call and logs nothing when no webhook URL is configured', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await new Notifier(undefined, undefined, logger).notify(notification());

            expect(fetchMock).not.toHaveBeenCalled();
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    describe('posting the payload', () => {
        it('POSTs the notification as JSON to the configured webhook', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);

            await new Notifier('https://hooks.example/notify', undefined, fakeLogger()).notify(
                notification({ cardId: '0072', title: 'a card', stage: 'review', moment: 'manual' }),
            );

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('https://hooks.example/notify');
            expect(init.method).toBe('POST');
            expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
            expect(JSON.parse(init.body as string)).toEqual({
                moment: 'manual',
                project: 'wilson',
                cardId: '0072',
                title: 'a card',
                stage: 'review',
            });
        });

        it('carries the reason when the notification has one', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);

            await new Notifier('https://hooks.example/notify', undefined, fakeLogger()).notify(
                notification({ moment: 'poisoned', reason: 'credit balance too low' }),
            );

            const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
            expect(body.reason).toBe('credit balance too low');
        });

        it('omits the reason key entirely when the notification carries none', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);

            await new Notifier('https://hooks.example/notify', undefined, fakeLogger()).notify(notification({ reason: undefined }));

            const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
            expect('reason' in body).toBe(false);
        });

        it('builds a deep link to the card from the base URL, stripping a trailing slash', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);

            await new Notifier('https://hooks.example/notify', 'https://board.example/', fakeLogger()).notify(notification({ cardId: '0072' }));

            const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
            expect(body.url).toBe('https://board.example/cards/0072');
        });

        it('omits the deep link entirely when no base URL is configured, even with a webhook set', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
            vi.stubGlobal('fetch', fetchMock);

            await new Notifier('https://hooks.example/notify', undefined, fakeLogger()).notify(notification());

            const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
            expect('url' in body).toBe(false);
        });
    });

    describe('failure is logged and swallowed, never thrown', () => {
        it('does not throw, and logs a warning, when the webhook rejects (network failure)', async () => {
            const fetchMock = vi.fn(async () => {
                throw new Error('ECONNREFUSED');
            });
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await expect(
                new Notifier('https://hooks.example/notify', undefined, logger).notify(notification({ cardId: '0072' })),
            ).resolves.toBeUndefined();

            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain('0072');
            expect(logger.warn.mock.calls[0][0]).toContain('ECONNREFUSED');
        });

        it('does not throw, and logs a warning naming the status, when the webhook responds with a 500', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await expect(
                new Notifier('https://hooks.example/notify', undefined, logger).notify(notification({ cardId: '0072' })),
            ).resolves.toBeUndefined();

            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain('0072');
            expect(logger.warn.mock.calls[0][0]).toContain('500');
        });

        it('logs nothing when the webhook responds ok', async () => {
            const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            await new Notifier('https://hooks.example/notify', undefined, logger).notify(notification());

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('aborts a webhook call that never responds, rather than hanging forever', async () => {
            vi.useFakeTimers();
            const fetchMock = vi.fn(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                    }),
            );
            vi.stubGlobal('fetch', fetchMock);
            const logger = fakeLogger();

            const pending = new Notifier('https://hooks.example/notify', undefined, logger).notify(notification({ cardId: '0072' }));

            // Card 0107: `notify()` now awaits a real DNS lookup (`checkWebhookDestination`) before
            // it ever creates the abort timeout `advanceTimersByTimeAsync` below is meant to fire —
            // that lookup is genuine OS-level I/O, not a fake timer, so it needs a real (not
            // simulated) tick to resolve. Without this, the abort timeout does not exist yet when
            // fake time is advanced, and `pending` hangs until vitest's own real test timeout.
            await new Promise(resolve => realSetTimeout(resolve, 50));
            await vi.advanceTimersByTimeAsync(5_000);
            await pending;

            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain('0072');
        });
    });
});
