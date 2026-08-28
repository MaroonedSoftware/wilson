import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Card 0149. Which project's `BoardConfig` a consumer sees, for whatever unit of work is currently
 * running — the resolution mechanism the card's Constraints ask for, decided once and applied
 * everywhere `BoardConfig` is read.
 *
 * **The choice: an ambient context (`AsyncLocalStorage`), not a DI scope and not a threaded
 * parameter.** `BoardConfig` is injected in 34 files today (per the plan), spanning modules this
 * card cannot touch — `stages`, `notify`, `settings`, `events` among them — every one of which reads
 * `config.project`/`config.boardRoot`/etc. as a plain property, not a method call. Two consumers
 * inside this card's own scope decide which project a unit of work is for: `Poller.tick`, walking
 * every registered project, and `CardStageJob.run`, dispatching one job that names its project in its
 * payload. Everything downstream of those two — `BoardRepository`, `WorktreeManager`, `StageDispatcher`,
 * `SettingsStore`, `Notifier`, `EventLog` callers — already reads `BoardConfig`'s fields fresh on
 * every call rather than caching them at construction time (see e.g. `PostgresBoardRepository`, every
 * method re-reading `this.config.project`). An ambient context exploits exactly that: the same
 * `BoardConfig` *instance* every one of those 34 files already holds a reference to can answer
 * differently on every read, based on which project's work is currently on the call stack, with zero
 * change to any of them.
 *
 * **Rejected: a container scope that resolves a per-project `BoardConfig`.** InjectKit supports this
 * (`Container.createScopedContainer()` + `scope.override()`), but two things rule it out here. First,
 * a singleton's dependencies resolve from the *root* container, never a scope's overrides (InjectKit's
 * own rule 5) — and `Poller`, `BoundedCardStageJobRunner` and most of what they depend on are
 * singletons registered in modules outside this card's files in scope, so making the override visible
 * to them would mean changing those registrations' lifetimes too, which is exactly the widening the
 * plan's Constraints forbid. Second, and decisively: `CardStageJob` is not resolved by this codebase at
 * all — `@maroonedsoftware/jobbroker`'s `PgBossJobRunner` resolves job handler instances from the
 * container it was built with, on the library's own schedule, so there is no call site here where a
 * per-job scope could be created and handed to it.
 *
 * **Rejected: threading a `project` parameter through every method signature.** This is the only
 * option that needs no read of `BoardConfig` to be ambient, but it means adding a parameter to every
 * method on `BoardRepository`, `WorktreeManager`, `StageDispatcher`, `SettingsStore`, `Notifier`, and
 * every call site of each — the 34 files, again, most of them outside `apps/api/src/modules/board/**`,
 * `jobs/**` and `worktree/**`. Not a smaller change than this card's two entry points; a much larger
 * one, spread across files this card's plan deliberately does not open.
 *
 * `runAsProject` is the only way to change what {@link currentProject} answers — there is no public
 * setter, so a project can only ever be "entered" for the duration of a callback, never left set as a
 * side effect. `Poller.tick` calls it once per registered project, per tick; `CardStageJob.run` calls
 * it once, for the job's own project, wrapping the whole dispatch. Nothing outside those two ever
 * needs to call it directly.
 *
 * Anything that runs with no `runAsProject` on its call stack — every HTTP request today, and the
 * `BoardModule.setup`/`start` boot sequence itself — sees no override at all: `currentProject()`
 * returns `undefined`, and `BoardConfig`'s own implementation (`board.config.ts`) falls back to the
 * daemon's configured project in that case. That fallback is what keeps the HTTP surface serving
 * exactly the one project it always has (out of scope for this card, per the plan) without this
 * context needing to know that surface exists at all.
 */
const storage = new AsyncLocalStorage<string>();

/** Run `fn` with `project` as the answer every {@link currentProject} call sees until it settles. */
export const runAsProject = <T>(project: string, fn: () => Promise<T>): Promise<T> => storage.run(project, fn);

/** The project the currently running unit of work is for, or `undefined` outside any {@link runAsProject}. */
export const currentProject = (): string | undefined => storage.getStore();
