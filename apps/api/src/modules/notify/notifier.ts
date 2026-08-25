import { ConsoleLogger, type Logger } from '@maroonedsoftware/logger';
import type { CardNotification } from './notification.js';

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
     * failed").
     */
    async notify(notification: CardNotification): Promise<void> {
        if (!this.webhookUrl) return;

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
            });
            if (!response.ok) {
                this.logger.warn(`notify webhook for ${notification.cardId} (${notification.moment}) returned ${response.status}`);
            }
        } catch (error) {
            this.logger.warn(`notify webhook for ${notification.cardId} (${notification.moment}) failed: ${(error as Error).message}`);
        } finally {
            clearTimeout(timeout);
        }
    }
}
