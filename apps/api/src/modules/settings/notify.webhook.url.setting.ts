import type { SettingDefinition } from './setting.definition.js';

/**
 * The webhook this daemon POSTs a notification to (card 0050) — a database row overriding
 * `NOTIFY_WEBHOOK_URL` overriding "unset" (`SettingsStore.get`'s usual order), settable at runtime
 * as of card 0107.
 *
 * Unlike `POLLER_INTERVAL_MS`/`CARD_STAGE_CONCURRENCY`, `parseEnv` is the identity function on
 * purpose: an environment-configured webhook was never validated before this card, and staying
 * that lenient here keeps an existing deployment booting exactly as it did. Judging the value —
 * `https` only, resolved address not loopback/link-local/private/unspecified — is
 * `checkWebhookDestination`'s job (`modules/notify/webhook.destination.ts`), run at write
 * (`NotifyWebhookSettingService.set`) and again at every use (`Notifier.notify`), never here.
 *
 * `scope: 'project'` (card 0152) — where *this project's* notifications go: two projects on one
 * deployment routing to the same webhook is a coincidence an operator can still configure by
 * setting both rows to the same URL, not a reason to make the URL itself deployment-wide and take
 * away the ability to point one project somewhere else.
 */
export const NOTIFY_WEBHOOK_URL: SettingDefinition<string | undefined> = {
    key: 'notify-webhook-url',
    scope: 'project',
    envVar: 'NOTIFY_WEBHOOK_URL',
    parseEnv: raw => raw,
    defaultValue: undefined,
};
