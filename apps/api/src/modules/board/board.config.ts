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
}

export class StaticBoardConfig extends BoardConfig {
    constructor(
        readonly project: string,
        readonly boardRoot: string,
        readonly codeRoot: string,
        readonly worktreeRoot: string,
        readonly runRoot: string,
    ) {
        super();
    }
}
