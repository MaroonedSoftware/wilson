import { ServerKitModule } from '@maroonedsoftware/koa';
import { AgentModule } from './agent/agent.module.js';
import { BoardModule } from './board/board.module.js';
import { ContextModule } from './context/context.module.js';
import { HealthModule } from './health/health.module.js';
import { DataModule } from './data/data.module.js';
import { EventsModule } from './events/events.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { LeaseModule } from './lease/lease.module.js';
import { LearningsModule } from './learnings/learnings.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SourcesModule } from './sources/sources.module.js';
import { StagesModule } from './stages/stages.module.js';
import { WorktreeModule } from './worktree/worktree.module.js';

/**
 * The module list, and the order is meaningful.
 *
 * `setup` / `start` / `ready` walk it forwards and `shutdown` walks it backwards, so a module tears
 * down before the modules it depends on — which is why Data is first: it owns the pool, and
 * everything that might still be writing an event has stopped by the time it closes. Jobs is last
 * to start (after Stages, what `CardStageJob` dispatches into, and after Settings, whose
 * `PollerSettingService` it asks at start-up) and first to shut down (before anything it might
 * still be running against tears down underneath it).
 *
 * Lease is listed after Board and before Worktree (card 0165): `LeaseService` depends on
 * `BoardRepository`, and `WorktreeManager` now depends on `LeaseService` to release a card's
 * leases when its worktree is reclaimed. `setup` only registers tokens, so — as with every other
 * ordering note here — the actual container resolution does not depend on this order; it is for a
 * reader tracing the dependency the same direction the list reads.
 *
 * Context is listed after Board and after Data (card 0187): `CardContextRepository` takes
 * `BoardConfig`, and `ContextService` takes `BoardRepository` to answer "does this card exist" the
 * same way `PlanService` does — both already registered by the time this module's turn comes.
 *
 * Sources is listed right after Board (card 0203): `InboundCardWriter` takes `BoardWriteService` and
 * `BoardRepository`, both registered by Board's own `setup`.
 *
 * Learnings is listed beside Stages (card 0239): `PostgresLearningsStore` takes `BoardConfig` and
 * `Kysely<DB>`, the same two dependencies `PostgresStageConfigStore` does, both already registered
 * by the time either module's turn comes (Board and Data are earlier in this list).
 */
export const modules: ServerKitModule[] = [
    DataModule,
    EventsModule,
    BoardModule,
    SourcesModule,
    ContextModule,
    HealthModule,
    LeaseModule,
    WorktreeModule,
    AgentModule,
    StagesModule,
    LearningsModule,
    SettingsModule,
    JobsModule,
];
