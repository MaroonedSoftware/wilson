import { Injectable } from 'injectkit';

/**
 * Where this project's board and worktrees live.
 *
 * One project for now — this repo (PROJECT.md, "not in step 0": multi-project). Registered as a
 * concrete instance by BoardModule so the multi-project registry at step 9 replaces the
 * registration, not every consumer.
 *
 * Card 0148: the values below are read from the configured project's `runner.projects` row, not
 * assembled from the environment on every boot — see `BoardModule.setup`'s `resolveProjectRow` for
 * how the row is read, or created from the environment on a project's first boot.
 */
@Injectable()
export abstract class BoardConfig {
    /** The project's name, as it appears in the event log. */
    abstract readonly project: string;
    /** Absolute path to the board repo clone (the sibling `*.board` repo). */
    abstract readonly boardRoot: string;
    /** Absolute path to the code repo worktrees are cut from. */
    abstract readonly codeRoot: string;
    /** Absolute path under which per-card worktrees are created. */
    abstract readonly worktreeRoot: string;
    /** Absolute path under which a card's plan is materialized for a running stage. */
    abstract readonly runRoot: string;
    /**
     * Where to POST a notification when a card needs a human (card 0050). Undefined means
     * notifications are off — no second channel, no webhook attempted, nothing logged.
     *
     * Not `readonly` as of card 0107: this became a `runner.settings`-backed setting, and both its
     * readers (`StageDispatcher`, `CardStageJob`) already read it fresh on every notification rather
     * than caching it anywhere — so making it settable at runtime needed nothing from them. The
     * settings module owns writing it: `NotifyWebhookSettingService` mutates this field in place on
     * every `set` and once at boot, the same way `PollerSettingService` pushes `POLLER_ENABLED`
     * into the live `Poller` instead of caching it somewhere new. Never assign to this field from
     * anywhere else — a second writer would race the settings store's own idea of the current value.
     */
    abstract notifyWebhookUrl: string | undefined;
    /**
     * Base URL of the web app, for building a deep link to the card in a notification. Beside
     * `notifyWebhookUrl` rather than its own config, since a link with nothing to post it to is
     * as useless as a webhook with no way to name the card it is about.
     *
     * Also settings-backed as of card 0107 (`NotifyWebhookSettingService` again), and also not
     * `readonly` for the same reason — but it is a link inside a payload, not an outbound
     * destination, so unlike `notifyWebhookUrl` it carries none of `checkWebhookDestination`'s
     * validation.
     */
    abstract notifyBaseUrl: string | undefined;
}

export class StaticBoardConfig extends BoardConfig {
    constructor(
        readonly project: string,
        readonly boardRoot: string,
        readonly codeRoot: string,
        readonly worktreeRoot: string,
        readonly runRoot: string,
        public notifyWebhookUrl: string | undefined = undefined,
        public notifyBaseUrl: string | undefined = undefined,
    ) {
        super();
    }
}
