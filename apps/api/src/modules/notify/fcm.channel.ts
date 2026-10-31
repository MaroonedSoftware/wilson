import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Logger } from '@maroonedsoftware/logger';
import type { CardNotification } from './notification.js';
import type { NotificationChannel } from './notifier.js';

/** How long each call to Google may take. */
const FCM_TIMEOUT_MS = 5_000;

/** Google's tokens last an hour; this one is replaced with ten minutes to spare. */
const ACCESS_TOKEN_LIFETIME_S = 3600;
const ACCESS_TOKEN_MARGIN_S = 600;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** The fields of a Firebase service-account file this channel reads. */
export interface FcmServiceAccount {
    readonly project_id: string;
    readonly client_email: string;
    readonly private_key: string;
}

/** The tokens to send to, and how to forget one FCM says is dead. `DeviceRepository` in production. */
export interface PushDevices {
    tokens(): Promise<string[]>;
    remove(token: string): Promise<void>;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** The signed assertion Google trades for an access token (RFC 7523). */
export const signAssertion = (account: FcmServiceAccount, nowS: number): string => {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
        JSON.stringify({ iss: account.client_email, scope: MESSAGING_SCOPE, aud: TOKEN_URL, iat: nowS, exp: nowS + ACCESS_TOKEN_LIFETIME_S }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key);
    return `${header}.${claims}.${base64url(signature)}`;
};

/**
 * Sends a notification to every registered phone through FCM's HTTP v1 API.
 *
 * **Ids only.** A card's title and a failure's reason describe private work, and this payload passes
 * through Google, so the message carries the moment, the project and the card id. The app fetches the
 * title itself, over its own session, when the message lands.
 *
 * **A data message at high priority**, so the app decides what to show and is woken to do it.
 *
 * At most once, like the webhook: a failed send is logged and dropped, and only FCM naming a token
 * dead removes it. Signing is by hand with `node:crypto`, because this one exchange is all that is
 * needed of Google's client library.
 */
export class FcmChannel implements NotificationChannel {
    readonly name = 'fcm';
    private accessToken?: { value: string; expiresAtS: number };

    constructor(
        private readonly account: FcmServiceAccount,
        private readonly devices: PushDevices,
        private readonly logger: Logger,
        private readonly nowS: () => number = () => Math.floor(Date.now() / 1000),
    ) {}

    async send(notification: CardNotification): Promise<void> {
        const tokens = await this.devices.tokens();
        if (tokens.length === 0) return;
        const bearer = await this.bearer();
        await Promise.all(tokens.map(token => this.sendTo(token, bearer, notification)));
    }

    private async bearer(): Promise<string> {
        const now = this.nowS();
        if (this.accessToken && this.accessToken.expiresAtS > now) return this.accessToken.value;

        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: signAssertion(this.account, now),
            }),
            signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Google refused the service account with ${response.status}`);
        const { access_token: value } = (await response.json()) as { access_token: string };
        this.accessToken = { value, expiresAtS: now + ACCESS_TOKEN_LIFETIME_S - ACCESS_TOKEN_MARGIN_S };
        return value;
    }

    private async sendTo(token: string, bearer: string, notification: CardNotification): Promise<void> {
        try {
            const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
                body: JSON.stringify({
                    message: {
                        token,
                        android: { priority: 'high' },
                        data: { moment: notification.moment, project: notification.project, cardId: notification.cardId },
                    },
                }),
                signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
            });
            if (response.ok) return;
            if (await isDeadToken(response)) await this.devices.remove(token);
            else this.logger.warn(`fcm for ${notification.cardId} (${notification.moment}) returned ${response.status}`);
        } catch (error) {
            this.logger.warn(`fcm for ${notification.cardId} (${notification.moment}) failed: ${(error as Error).message}`);
        }
    }
}

/** FCM's way of saying an install is gone. A 404 with no such detail may be a wrong project, so it is not one. */
const isDeadToken = async (response: Response): Promise<boolean> => {
    if (response.status !== 404 && response.status !== 400) return false;
    const body = (await response.json().catch(() => undefined)) as { error?: { details?: { errorCode?: string }[] } } | undefined;
    return body?.error?.details?.some(detail => detail.errorCode === 'UNREGISTERED') ?? false;
};

/**
 * The channel for a service-account file, or `undefined` when none is configured. Off by default. A
 * file that cannot be read turns push off with a warning: a notification must never cost the daemon.
 */
export const fcmChannelFrom = async (file: string | undefined, devices: PushDevices, logger: Logger): Promise<FcmChannel | undefined> => {
    if (!file) return undefined;
    try {
        return new FcmChannel(JSON.parse(await readFile(file, 'utf8')) as FcmServiceAccount, devices, logger);
    } catch (error) {
        logger.warn(`push notifications are off: could not read ${file}: ${(error as Error).message}`);
        return undefined;
    }
};
