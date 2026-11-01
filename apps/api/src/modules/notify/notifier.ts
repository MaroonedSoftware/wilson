import { ConsoleLogger, type Logger } from '@maroonedsoftware/logger';
import type { CardNotification } from './notification.js';
import { checkWebhookDestination, warnOnceInvalidWebhook } from './webhook.destination.js';

/**
 * Somewhere else a notification can go besides the webhook. `send` may throw: `Notifier` catches it,
 * so a channel need not repeat the rule that a notification never fails a stage.
 */
export interface NotificationChannel {
    readonly name: string;
    send(notification: CardNotification): Promise<void>;
}

/**
 * The extra channels, registered once at boot. Module-level for the reason `cardFeed` is, and because
 * six call sites construct `Notifier` by hand: this way none of them has to learn about any channel.
 */
const channels: NotificationChannel[] = [];

/** Adds a channel, and hands back how to take it off again. */
export const registerNotificationChannel = (channel: NotificationChannel): (() => void) => {
    channels.push(channel);
    return () => {
        channels.splice(channels.indexOf(channel), 1);
    };
};

/** How long the notifier waits for the webhook before giving up on it. */
const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * Posts one notification as JSON to the configured webhook — the one channel this project has for
 * telling a person, off the board, that the machine stopped (card 0050; PROJECT.md, Notification).
 * No second channel, no delivery guarantee beyond at-most-once (Out of scope).
 *
 * Not DI-managed: `webhookUrl`/`baseUrl` come from `BoardConfig`, already injected into every
 * caller (`CardStageJob`, `StageDispatcher`), so constructing one by hand where it is used costs
 * nothing and needs no wiring of its own. `logger` defaults to a plain `ConsoleLogger` for the one
 * caller (`CardStageJob`) that has no injected `Logger`; `StageDispatcher` passes its real one.
 *
 * `webhookUrl` is `BoardConfig.notifyWebhookUrl`, which card 0107 made settable at runtime — a
 * `wilson.settings` row can override it without a restart, pushed onto the same `BoardConfig`
 * instance both callers already read fresh on every call (`NotifyWebhookSettingService`, settings
 * module). Nothing here needed to change for that: this class already read the value at call time
 * rather than caching it, so the mechanism was free. What this class does add is the destination
 * check — see `notify` below.
 */
export class Notifier {
    constructor(
        private readonly webhookUrl: string | undefined,
        private readonly baseUrl: string | undefined,
        private readonly logger: Logger = new ConsoleLogger(),
    ) {}

    /**
     * Off by default: absent config makes this a no-op that costs nothing — no HTTP call and no log
     * line, on every transition the runner ever makes (Constraints: "Off by default").
     *
     * Never throws. A webhook that times out, 500s, or points at nothing is logged and swallowed —
     * the transition this reports on has already committed, and a notification able to unwind it is
     * worse than no notification at all (Constraints: "Never fail a stage because a notification
     * failed"). The same goes for every registered channel, and one failing never stops another.
     */
    async notify(notification: CardNotification): Promise<void> {
        await Promise.all([this.postWebhook(notification), ...channels.map(channel => this.sendTo(channel, notification))]);
    }

    private async sendTo(channel: NotificationChannel, notification: CardNotification): Promise<void> {
        try {
            await channel.send(notification);
        } catch (error) {
            this.logger.warn(`notify ${channel.name} for ${notification.cardId} (${notification.moment}) failed: ${(error as Error).message}`);
        }
    }

    private async postWebhook(notification: CardNotification): Promise<void> {
        if (!this.webhookUrl) return;

        // Card 0107: re-checked on every call, not trusted from whatever validated it at write
        // time — DNS answers change between the two, and this is the check that actually protects
        // anything (see `checkWebhookDestination`'s own doc for the full reasoning and its limits).
        // An invalid destination behaves exactly like an unset one: no request, and the reason is
        // logged once rather than on every notification (`warnOnceInvalidWebhook`).
        const destination = await checkWebhookDestination(this.webhookUrl);
        if (!destination.ok) {
            warnOnceInvalidWebhook(this.logger, this.webhookUrl, destination.reason);
            return;
        }

        const payload = {
            moment: notification.moment,
            project: notification.project,
            cardId: notification.cardId,
            title: notification.title,
            stage: notification.stage,
            ...(notification.reason ? { reason: notification.reason } : {}),
            ...(this.baseUrl ? { url: `${this.baseUrl.replace(/\/+$/, '')}/cards/${notification.cardId}` } : {}),
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
        try {
            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
                // Card 0107: refused, not followed. A redirect is only visible once the request is
                // already in flight, past the point `checkWebhookDestination` above could have
                // judged it — re-validating each hop instead would mean chasing an arbitrary chain
                // of them, and the configured URL is what an operator approved, not wherever it
                // might bounce to. `redirect: 'manual'` makes a 3xx response land here as
                // `type: 'opaqueredirect'` instead of being followed automatically.
                redirect: 'manual',
            });
            if (response.type === 'opaqueredirect') {
                this.logger.warn(
                    `notify webhook for ${notification.cardId} (${notification.moment}) refused: server responded with a redirect, which is not followed`,
                );
            } else if (!response.ok) {
                this.logger.warn(`notify webhook for ${notification.cardId} (${notification.moment}) returned ${response.status}`);
            }
        } catch (error) {
            this.logger.warn(`notify webhook for ${notification.cardId} (${notification.moment}) failed: ${(error as Error).message}`);
        } finally {
            clearTimeout(timeout);
        }
    }
}
