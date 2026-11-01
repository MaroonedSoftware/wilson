import { describe, expect, it, vi } from 'vitest';
import { checkWebhookDestination, warnOnceInvalidWebhook } from '#modules/notify/webhook.destination.js';
import type { Logger } from '@maroonedsoftware/logger';

// `checkWebhookDestination` calls `dns.promises.lookup` for real. Wrapping (not replacing) it keeps
// every test below fast and network-free: a literal IP address resolves through the real
// implementation instantly (no socket, no query — `getaddrinfo` short-circuits on a numeric host),
// while the handful of tests that need a hostname to resolve to something a literal IP can't express
// (several addresses at once, or a lookup failure) override it for one call with `mockResolvedValueOnce`
// / `mockRejectedValueOnce`.
vi.mock('node:dns/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:dns/promises')>();
    return { ...actual, lookup: vi.fn(actual.lookup) };
});
import { lookup } from 'node:dns/promises';

const fakeLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

/**
 * Card 0107's core rule: judge the address the request would actually reach, not the string the
 * operator typed. These tests exercise `checkWebhookDestination` directly rather than through
 * `Notifier` or the settings write path, since both of those just relay whatever this function
 * decides.
 */
describe('checkWebhookDestination', () => {
    describe('scheme', () => {
        it('refuses a plain http URL, naming the scheme it saw', async () => {
            const result = await checkWebhookDestination('http://example.com/hook');

            expect(result.ok).toBe(false);
            expect(result).toMatchObject({ reason: expect.stringContaining('https') });
            if (!result.ok) expect(result.reason).toContain('http');
        });

        it('refuses a string that does not parse as a URL at all', async () => {
            const result = await checkWebhookDestination('this is not a url');

            expect(result.ok).toBe(false);
        });
    });

    describe('resolved address, IPv4', () => {
        it.each([
            ['https://127.0.0.1/hook', 'loopback', '127.0.0.1'],
            ['https://169.254.169.254/hook', 'link-local', '169.254.169.254'],
            ['https://10.1.2.3/hook', 'private', '10.1.2.3'],
            ['https://172.20.5.9/hook', 'private', '172.20.5.9'],
            ['https://192.168.1.1/hook', 'private', '192.168.1.1'],
            ['https://0.0.0.0/hook', 'unspecified', '0.0.0.0'],
        ])('refuses %s as %s, naming both the rule and the resolved address', async (url, rule, address) => {
            const result = await checkWebhookDestination(url);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.reason).toContain(rule);
                expect(result.reason).toContain(address);
            }
        });

        it('leaves an ordinary public IPv4 literal alone', async () => {
            await expect(checkWebhookDestination('https://93.184.216.34/hook')).resolves.toEqual({ ok: true });
        });
    });

    describe('resolved address, IPv6', () => {
        it.each([
            ['https://[::1]/hook', 'loopback'],
            ['https://[fe80::1]/hook', 'link-local'],
            ['https://[fc00::1]/hook', 'private'],
            ['https://[::]/hook', 'unspecified'],
            // An IPv4-mapped IPv6 address carries the same address under a different notation, and
            // must be judged by what it maps to, not waved through because the literal itself isn't
            // one of the IPv4 forms `disallowedAddressRule` matches directly.
            ['https://[::ffff:127.0.0.1]/hook', 'loopback'],
            ['https://[::ffff:10.0.0.5]/hook', 'private'],
        ])('refuses %s as %s', async (url, rule) => {
            const result = await checkWebhookDestination(url);

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toContain(rule);
        });

        it('leaves an ordinary public IPv6 literal alone', async () => {
            await expect(checkWebhookDestination('https://[2001:4860:4860::8888]/hook')).resolves.toEqual({ ok: true });
        });
    });

    describe('ranges that reach inside a network without looking private', () => {
        it.each([
            ['100.64.0.1', 'shared'],
            ['100.127.255.254', 'shared'],
            ['0.1.2.3', 'unspecified'],
            ['192.0.0.8', 'reserved'],
            ['198.18.0.1', 'reserved'],
            ['198.19.255.255', 'reserved'],
        ])('refuses %s as %s', async (address, rule) => {
            expect(await checkWebhookDestination(`https://${address}/hook`)).toMatchObject({ ok: false, reason: expect.stringContaining(rule) });
        });

        it.each(['100.63.255.255', '100.128.0.1', '192.0.1.1', '198.17.0.1', '198.20.0.1'])('leaves the public neighbour %s alone', async address => {
            expect(await checkWebhookDestination(`https://${address}/hook`)).toEqual({ ok: true });
        });

        it.each([
            ['fe90::1', 'link-local'],
            ['febf::1', 'link-local'],
            ['0:0:0:0:0:0:0:1', 'loopback'],
            ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
            ['::ffff:a00:1', 'private'],
            ['::7f00:1', 'loopback'],
            ['64:ff9b::7f00:1', 'loopback'],
            ['64:ff9b::a9fe:a9fe', 'link-local'],
            ['64:ff9b::192.168.0.1', 'private'],
            ['64:ff9b:1::1', 'private'],
            ['2002:7f00:1::', 'loopback'],
            ['2002:0a00:0001::1', 'private'],
            ['2002:a9fe:a9fe::', 'link-local'],
        ])('refuses the IPv6 form %s as %s', async (address, rule) => {
            expect(await checkWebhookDestination(`https://[${address}]/hook`)).toMatchObject({ ok: false, reason: expect.stringContaining(rule) });
        });

        it.each(['64:ff9b::808:808', '2002:808:808::1'])('leaves %s alone, which carries a public address', async address => {
            expect(await checkWebhookDestination(`https://[${address}]/hook`)).toEqual({ ok: true });
        });
    });

    describe('a hostname with more than one resolved address', () => {
        it('refuses the URL when any resolved address is disallowed, even if it is not the first', async () => {
            vi.mocked(lookup).mockResolvedValueOnce([
                { address: '8.8.8.8', family: 4 },
                { address: '169.254.169.254', family: 4 },
            ] as never);

            const result = await checkWebhookDestination('https://multi-answer.example/hook');

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toContain('169.254.169.254');
        });

        it('allows the URL only when every resolved address is allowed', async () => {
            vi.mocked(lookup).mockResolvedValueOnce([
                { address: '8.8.8.8', family: 4 },
                { address: '1.1.1.1', family: 4 },
            ] as never);

            await expect(checkWebhookDestination('https://multi-answer-clean.example/hook')).resolves.toEqual({ ok: true });
        });
    });

    describe('a hostname that fails to resolve', () => {
        it("is treated as ok — a broken name is not this function's job to reject", async () => {
            vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }));

            await expect(checkWebhookDestination('https://does-not-resolve.example/hook')).resolves.toEqual({ ok: true });
        });
    });
});

/**
 * Card 0107's Task 3: "an invalid stored value must behave like unset with a logged reason, never
 * like a failure that interferes with a card" — logged once, not on every call that discovers it.
 * Each test below uses its own URL so it cannot be affected by another test's entry in the
 * module-level dedup cache.
 */
describe('warnOnceInvalidWebhook', () => {
    it('logs the reason the first time a URL is judged invalid', () => {
        const logger = fakeLogger();

        warnOnceInvalidWebhook(logger, 'https://warn-once-a.example/hook', 'resolves to a private address (10.0.0.1)');

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0]![0]).toContain('resolves to a private address (10.0.0.1)');
    });

    it('does not log again for the same URL failing the same way', () => {
        const logger = fakeLogger();
        const url = 'https://warn-once-b.example/hook';

        warnOnceInvalidWebhook(logger, url, 'same reason every time');
        warnOnceInvalidWebhook(logger, url, 'same reason every time');
        warnOnceInvalidWebhook(logger, url, 'same reason every time');

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('logs again when the reason for the same URL changes', () => {
        const logger = fakeLogger();
        const url = 'https://warn-once-c.example/hook';

        warnOnceInvalidWebhook(logger, url, 'reason A');
        warnOnceInvalidWebhook(logger, url, 'reason B');

        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('logs independently for a different URL, even with the identical reason', () => {
        const logger = fakeLogger();

        warnOnceInvalidWebhook(logger, 'https://warn-once-d1.example/hook', 'shared reason text');
        warnOnceInvalidWebhook(logger, 'https://warn-once-d2.example/hook', 'shared reason text');

        expect(logger.warn).toHaveBeenCalledTimes(2);
    });
});
