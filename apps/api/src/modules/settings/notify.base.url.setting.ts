import type { SettingDefinition } from './setting.definition.js';

/**
 * Base URL of the web app, used only to build a deep link inside a notification payload
 * (`Notifier.notify`) — settable alongside `NOTIFY_WEBHOOK_URL` as of card 0107, since a webhook
 * with no way to link back to the card it is about is as useless as a link with nothing to post it
 * in.
 *
 * Not an outbound destination itself, so it carries none of `checkWebhookDestination`'s treatment
 * (card 0107's Constraints say so explicitly) — a plain passthrough, the same as this value has
 * always been.
 */
export const NOTIFY_BASE_URL: SettingDefinition<string | undefined> = {
    key: 'notify-base-url',
    envVar: 'NOTIFY_BASE_URL',
    parseEnv: raw => raw,
    defaultValue: undefined,
};
