import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { checkWebhookDestination, warnOnceInvalidWebhook } from '#modules/notify/webhook.destination.js';
import type { NotifyWebhookSetting, SetNotifyWebhookSettingRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { NOTIFY_WEBHOOK_URL } from './notify.webhook.url.setting.js';
import { NOTIFY_BASE_URL } from './notify.base.url.setting.js';

/**
 * The notification webhook and its companion base URL, live: a write here reaches `BoardConfig`
 * immediately (`applyCurrentValue` below), the same way `PollerSettingService.set` reaches the
 * running `Poller` — no restart, and `Notifier` (both its callers already read `BoardConfig` fresh
 * on every notification) sees the new value on the very next one.
 *
 * `set` is where `checkWebhookDestination` (`modules/notify/webhook.destination.ts`) gets its
 * write-time call — refusing an unsafe `webhookUrl` here is what gives an operator an immediate
 * error instead of a silently-disabled webhook discovered only in the log the next time a card
 * needs a human. It is not the check that matters for safety, though: `Notifier.notify` runs the
 * same function again on every send, because a value safe at write can stop being safe by the time
 * it is used (see that function's own doc for the full reasoning, and for what this does not stop).
 * `baseUrl` is never checked — a link in a payload, not a destination (card 0107's Out of scope).
 */
@Injectable()
export class NotifyWebhookSettingService {
    constructor(
        private readonly settings: SettingsStore,
        private readonly config: BoardConfig,
        private readonly logger: Logger,
    ) {}

    /** The contract-facing read: the setting's current effective values, `null` where unset. */
    async get(): Promise<NotifyWebhookSetting> {
        const webhookUrl = await this.settings.get(NOTIFY_WEBHOOK_URL);
        const baseUrl = await this.settings.get(NOTIFY_BASE_URL);
        return { webhookUrl: webhookUrl ?? null, baseUrl: baseUrl ?? null };
    }

    /**
     * The contract-facing write: refuse an unsafe `webhookUrl` with the specific rule it broke
     * (the same refusal `curl` and a settings page would both see), otherwise persist both fields
     * and push them onto the live `BoardConfig`.
     */
    async set(body: SetNotifyWebhookSettingRequest): Promise<NotifyWebhookSetting> {
        if (body.webhookUrl !== null) {
            const check = await checkWebhookDestination(body.webhookUrl);
            if (!check.ok) {
                throw httpError(400).withDetails({ reason: check.reason });
            }
        }
        await this.settings.set(NOTIFY_WEBHOOK_URL, body.webhookUrl ?? undefined);
        await this.settings.set(NOTIFY_BASE_URL, body.baseUrl ?? undefined);
        return this.applyCurrentValue();
    }

    /**
     * Push whatever the settings store currently resolves to onto `BoardConfig` — called from
     * `set` above, and once at boot (`SettingsModule`'s `start` hook) so a database row already
     * present before this process started takes effect immediately, the same as
     * `PollerSettingService.applyCurrentValue` does for `POLLER_ENABLED`.
     *
     * A `webhookUrl` that fails `checkWebhookDestination` here — an environment value that was
     * never write-validated, or a database row whose DNS answer changed since it was written —
     * behaves exactly like unset: `BoardConfig.notifyWebhookUrl` is left `undefined`, no request is
     * ever attempted for it, and the reason is logged once, not on every call this runs from
     * (`warnOnceInvalidWebhook`'s cache, shared with `Notifier`'s own per-notification re-check).
     */
    async applyCurrentValue(): Promise<NotifyWebhookSetting> {
        const webhookUrl = await this.settings.get(NOTIFY_WEBHOOK_URL);
        const baseUrl = await this.settings.get(NOTIFY_BASE_URL);
        this.config.notifyBaseUrl = baseUrl;

        if (webhookUrl !== undefined) {
            const check = await checkWebhookDestination(webhookUrl);
            if (!check.ok) {
                warnOnceInvalidWebhook(this.logger, webhookUrl, check.reason);
                this.config.notifyWebhookUrl = undefined;
                return { webhookUrl: null, baseUrl: baseUrl ?? null };
            }
        }

        this.config.notifyWebhookUrl = webhookUrl;
        return { webhookUrl: webhookUrl ?? null, baseUrl: baseUrl ?? null };
    }
}
