import { ServerKitModule } from '@maroonedsoftware/koa';
import { AgentModule } from './agent/agent.module.js';
import { BoardModule } from './board/board.module.js';
import { DataModule } from './data/data.module.js';
import { EventsModule } from './events/events.module.js';
import { StagesModule } from './stages/stages.module.js';
import { WorktreeModule } from './worktree/worktree.module.js';

/**
 * The module list, and the order is meaningful.
 *
 * `setup` / `start` / `ready` walk it forwards and `shutdown` walks it backwards, so a module tears
 * down before the modules it depends on — which is why Data is first: it owns the pool, and
 * everything that might still be writing an event has stopped by the time it closes.
 */
export const modules: ServerKitModule[] = [DataModule, EventsModule, BoardModule, WorktreeModule, AgentModule, StagesModule];
