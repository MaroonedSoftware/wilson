import { Injectable } from 'injectkit';
import { currentProject } from './project.context.js';
import type { ProjectRow } from './project.repository.js';

/**
 * Where a project's board and worktrees live.
 *
 * Card 0149: registered as `ProjectScopedBoardConfig` by `BoardModule` — every field below now
 * answers for whichever project `project.context.ts`'s `runAsProject` currently has on the call
 * stack, not a value fixed for the process. See that file's doc comment for why an ambient context is
 * the mechanism, and this class's own `ProjectScopedBoardConfig` for the implementation. `StaticBoardConfig`,
 * below, is unchanged and stays fixed to one project — the simple fake most tests already construct,
 * for a class under test that has no reason to know multiple projects exist.
 *
 * Card 0148: the values below are read from a `wilson.projects` row, not assembled from the
 * environment on every boot — see `BoardModule.setup`'s `resolveProjectRow` for how the configured
 * project's row is read, or created from the environment, on its first boot.
 */
@Injectable()
export abstract class BoardConfig {
    /** The project's name, as it appears in the event log. */
    abstract readonly project: string;
    /** Absolute path to the code repo worktrees are cut from. */
    abstract readonly codeRoot: string;
    /** Absolute path under which per-card worktrees are created. */
    abstract readonly worktreeRoot: string;
    /** Absolute path under which a card's plan is materialized for a running stage. */
    abstract readonly runRoot: string;
    /**
     * Card 0149. Make `row` a project this config can answer for — a no-op here, overridden by
     * `ProjectScopedBoardConfig`.
     *
     * A concrete, non-abstract method rather than a second injected token: `Poller` and
     * `CardStageJob` already hold a `BoardConfig` (the abstract type every one of the 34 existing
     * consumers injects), and calling `register` on it needs no new dependency — on `StaticBoardConfig`
     * it does nothing, which is exactly right for a fixed single-project fake that never needs to
     * learn about a second project.
     */
    register(_row: ProjectRow): void {}
    /**
     * Where to POST a notification when a card needs a human (card 0050). Undefined means
     * notifications are off — no second channel, no webhook attempted, nothing logged.
     *
     * Not `readonly` as of card 0107: this became a `wilson.settings`-backed setting, and both its
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
        readonly codeRoot: string,
        readonly worktreeRoot: string,
        readonly runRoot: string,
        public notifyWebhookUrl: string | undefined = undefined,
        public notifyBaseUrl: string | undefined = undefined,
    ) {
        super();
    }
}

/** One project's paths and notification settings, as `ProjectScopedBoardConfig` holds them. */
interface ProjectEntry {
    codeRoot: string;
    worktreeRoot: string;
    runRoot: string;
    notifyWebhookUrl: string | undefined;
    notifyBaseUrl: string | undefined;
}

/**
 * Card 0149. The `BoardConfig` the running daemon registers — every field reads `project.context.ts`'s
 * `currentProject()`, falling back to `defaultProject` (the project this process's own environment
 * named at boot, per `BoardModule.setup`) when nothing has called `runAsProject`. That fallback is
 * what keeps every consumer that has not been made project-aware — every HTTP request today, and the
 * boot sequence itself — behaving exactly as it did with one project, per this card's "one project must
 * behave exactly as it does today" acceptance criterion.
 *
 * `register` is how a project's paths get here at all: `BoardModule` registers the boot-configured
 * project eagerly, at setup; `BoardModule`'s own `start` hook then registers every row already in
 * `wilson.projects` before `JobsModule` starts accepting (or redelivering) `card.stage` work, so a
 * job for a project that existed before this boot can never dispatch into an unregistered
 * `BoardConfig`; and `Poller.tick` re-registers every registered project on every tick, which is also
 * how a project added by hand while the daemon is already running is picked up — see that method's
 * own doc for why re-registering (rather than registering once) is deliberate. Idempotent and cheap:
 * it only overwrites the three path fields, preserving whatever `notifyWebhookUrl`/`notifyBaseUrl` a
 * settings write already recorded for that project, since neither of those lives in `wilson.projects`.
 *
 * Reading a project this class has never seen registered throws — a job or a tick that names an
 * unknown project is a genuine bug (the project's `wilson.projects` row vanished, or a payload named
 * one that was never created), not a case to paper over with a silent fallback that would run the
 * work against the wrong paths instead.
 */
export class ProjectScopedBoardConfig extends BoardConfig {
    private readonly projects = new Map<string, ProjectEntry>();

    constructor(private readonly defaultProject: string) {
        super();
    }

    register(row: ProjectRow): void {
        const existing = this.projects.get(row.name);
        this.projects.set(row.name, {
            codeRoot: row.codeRoot,
            worktreeRoot: row.worktreeRoot,
            runRoot: row.runRoot,
            notifyWebhookUrl: existing?.notifyWebhookUrl,
            notifyBaseUrl: existing?.notifyBaseUrl,
        });
    }

    get project(): string {
        return currentProject() ?? this.defaultProject;
    }

    get codeRoot(): string {
        return this.current().codeRoot;
    }

    get worktreeRoot(): string {
        return this.current().worktreeRoot;
    }

    get runRoot(): string {
        return this.current().runRoot;
    }

    get notifyWebhookUrl(): string | undefined {
        return this.current().notifyWebhookUrl;
    }

    set notifyWebhookUrl(value: string | undefined) {
        this.current().notifyWebhookUrl = value;
    }

    get notifyBaseUrl(): string | undefined {
        return this.current().notifyBaseUrl;
    }

    set notifyBaseUrl(value: string | undefined) {
        this.current().notifyBaseUrl = value;
    }

    private current(): ProjectEntry {
        const name = this.project;
        const entry = this.projects.get(name);
        if (!entry) {
            throw new Error(`BoardConfig: project "${name}" is not registered — see ProjectScopedBoardConfig.register`);
        }
        return entry;
    }
}
