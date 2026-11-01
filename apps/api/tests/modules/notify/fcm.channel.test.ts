import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@maroonedsoftware/logger';
import { FcmChannel, fcmChannelFrom, signAssertion, type FcmServiceAccount, type PushDevices } from '#modules/notify/fcm.channel.js';
import type { CardNotification } from '#modules/notify/notification.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account: FcmServiceAccount = {
    project_id: 'wilson-test',
    client_email: 'push@wilson-test.iam.example',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const notification: CardNotification = {
    project: 'wilson',
    cardId: '0050',
    title: 'A secret title',
    stage: 'review',
    moment: 'needs-human',
    reason: 'A secret reason',
};

const logger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
const devices = (tokens: string[]): PushDevices & { remove: ReturnType<typeof vi.fn> } => ({
    tokens: async () => tokens,
    remove: vi.fn(async () => undefined),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A stand-in for Google: answers the token exchange, and each send with `answer`. */
const google = (answer: (token: string) => Response = () => json({ name: 'sent' })) => {
    const sends: { url: string; authorization: string; message: Record<string, unknown> }[] = [];
    const exchanges = vi.fn();
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            if (url.includes('oauth2')) {
                exchanges(init.body?.toString());
                return json({ access_token: 'google-token' });
            }
            const { message } = JSON.parse(init.body as string) as { message: Record<string, unknown> & { token: string } };
            sends.push({ url, authorization: (init.headers as Record<string, string>).authorization!, message });
            return answer(message.token);
        }),
    );
    return { sends, exchanges };
};

describe('FcmChannel', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('signs an assertion Google can verify, for the messaging scope alone', () => {
        const [header, claims, signature] = signAssertion(account, 1000).split('.') as [string, string, string];

        const verified = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'));
        expect(verified).toBe(true);
        expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
            iss: account.client_email,
            scope: 'https://www.googleapis.com/auth/firebase.messaging',
            iat: 1000,
            exp: 4600,
        });
    });

    it('sends every phone a high-priority message to the right project', async () => {
        const { sends } = google();

        await new FcmChannel(account, devices(['a', 'b']), logger()).send(notification);

        expect(sends.map(send => send.message.token)).toEqual(['a', 'b']);
        expect(sends[0]!.url).toBe('https://fcm.googleapis.com/v1/projects/wilson-test/messages:send');
        expect(sends[0]!.authorization).toBe('Bearer google-token');
        expect(sends[0]!.message.android).toEqual({ priority: 'high' });
    });

    it('carries ids only, so no title or reason reaches Google', async () => {
        const { sends } = google();

        await new FcmChannel(account, devices(['a']), logger()).send(notification);

        expect(sends[0]!.message.data).toEqual({ moment: 'needs-human', project: 'wilson', cardId: '0050' });
        expect(JSON.stringify(sends)).not.toContain('secret');
    });

    it('asks Google for nothing when no phone is registered', async () => {
        const { exchanges } = google();

        await new FcmChannel(account, devices([]), logger()).send(notification);

        expect(exchanges).not.toHaveBeenCalled();
    });

    it('reuses its access token until it is nearly out', async () => {
        const { exchanges } = google();
        let now = 1000;
        const channel = new FcmChannel(account, devices(['a']), logger(), () => now);

        await channel.send(notification);
        now += 2000;
        await channel.send(notification);
        expect(exchanges).toHaveBeenCalledTimes(1);

        now += 2000;
        await channel.send(notification);
        expect(exchanges).toHaveBeenCalledTimes(2);
    });

    it('forgets a token FCM says is unregistered, and keeps sending to the rest', async () => {
        const { sends } = google(token =>
            token === 'dead' ? json({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }, 404) : json({ name: 'sent' }),
        );
        const phones = devices(['dead', 'alive']);

        await new FcmChannel(account, phones, logger()).send(notification);

        expect(phones.remove).toHaveBeenCalledExactlyOnceWith('dead');
        expect(sends).toHaveLength(2);
    });

    it('keeps a token on a failure that says nothing about it', async () => {
        google(() => json({ error: { message: 'wrong project' } }, 404));
        const phones = devices(['a']);
        const log = logger();

        await new FcmChannel(account, phones, log).send(notification);

        expect(phones.remove).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith('fcm for 0050 (needs-human) returned 404');
    });

    it('survives one phone failing outright', async () => {
        google(token => {
            if (token === 'bad') throw new Error('socket hang up');
            return json({ name: 'sent' });
        });
        const log = logger();

        await expect(new FcmChannel(account, devices(['bad', 'good']), log).send(notification)).resolves.toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith('fcm for 0050 (needs-human) failed: socket hang up');
    });

    it('is off with no file configured, and reads one when it is', async () => {
        expect(await fcmChannelFrom(undefined, devices([]), logger())).toBeUndefined();

        const file = join(await mkdtemp(join(tmpdir(), 'fcm-')), 'account.json');
        await writeFile(file, JSON.stringify(account));
        expect(await fcmChannelFrom(file, devices([]), logger())).toBeInstanceOf(FcmChannel);
    });

    it('turns itself off, and says so, rather than stop the daemon over a bad file', async () => {
        const log = logger();

        expect(await fcmChannelFrom('/no/such/file.json', devices([]), log)).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('push notifications are off'));
    });
});
