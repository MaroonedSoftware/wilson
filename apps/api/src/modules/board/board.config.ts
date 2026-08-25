import { Injectable } from 'injectkit';

/**
 * Where this project's board and worktrees live.
 *
 * One project for now — this repo (PROJECT.md, "not in step 0": multi-project). Registered as a
 * concrete instance by BoardModule so the multi-project registry at step 9 replaces the
 * registration, not every consumer.
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
     */
    abstract readonly notifyWebhookUrl: string | undefined;
    /**
     * Base URL of the web app, for building a deep link to the card in a notification. Beside
     * `notifyWebhookUrl` rather than its own config, since a link with nothing to post it to is
     * as useless as a webhook with no way to name the card it is about.
     */
    abstract readonly notifyBaseUrl: string | undefined;
}

export class StaticBoardConfig extends BoardConfig {
    constructor(
        readonly project: string,
        readonly boardRoot: string,
        readonly codeRoot: string,
        readonly worktreeRoot: string,
        readonly runRoot: string,
        readonly notifyWebhookUrl: string | undefined = undefined,
        readonly notifyBaseUrl: string | undefined = undefined,
    ) {
        super();
    }
}
