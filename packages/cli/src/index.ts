#!/usr/bin/env node
import 'reflect-metadata';
import { createCliApp, type CommandModule, type CommandRegistration } from '@maroonedsoftware/johnny5';
import { nodeVersion } from '@maroonedsoftware/johnny5/versions';
import { envFile } from '@maroonedsoftware/johnny5/filesystem';
import { dockerServicesUp } from '@maroonedsoftware/johnny5/docker';
// `card plan` was the last command that built a real container via `requireContainer` — card 0085
// ports it onto the planning-session API (`api.board.openAPlanningSession`/`saveAPlanDraft`/
// `closeAPlanningSession`) the same way `wilson run`'s retirement (card 0079) and card 0078 ported
// every other command. Nothing in this package builds a container any more, so `createCliApp` needs
// no `config`/`modules` wiring and this file has no `@wilson/api` import left — `ctx.config` comes
// from johnny5's own default (`buildContext`'s default `envFiles` already includes `apps/api/.env`).
import boardInitCommand from './commands/board/init.command.js';
import boardImportCommand from './commands/board/import.command.js';
import cardListCommand from './commands/card/list.command.js';
import cardAckCommand from './commands/card/ack.command.js';
import cardApproveCommand from './commands/card/approve.command.js';
import cardCreateCommand from './commands/card/create.command.js';
import cardDependCommand from './commands/card/depend.command.js';
import cardEditCommand from './commands/card/edit.command.js';
import cardMoveCommand from './commands/card/move.command.js';
import cardNextCommand from './commands/card/next.command.js';
import cardPlanCommand from './commands/card/plan.command.js';
import cardReleaseCommand from './commands/card/release.command.js';
import cardShowCommand from './commands/card/show.command.js';
import cardSplitCommand from './commands/card/split.command.js';
import cardStartCommand from './commands/card/start.command.js';
import cardVersionsCommand from './commands/card/versions.command.js';

import { boardReady } from './checks/board.ready.js';
import { daemonCurrent } from './checks/daemon.current.js';
import { codeRepoReady } from './checks/code.repo.js';
import { postgresReachable } from './checks/postgres.reachable.js';
import { providerKeySet } from './checks/provider.key.js';
import { queueReachable } from './checks/queue.reachable.js';

// johnny5's `CommandRegistration.module` is typed as `CommandModule<Record<string, unknown>>`, but
// command files declare narrow `*Opts` interfaces so their `run` bodies stay type-safe. `reg()` is
// the single cast surface where the per-command opts widen back to the registry shape.
const reg = <O>(path: string[], module: CommandModule<O>): CommandRegistration => ({
    path,
    module: module as unknown as CommandModule,
});

const app = await createCliApp({
    name: 'wilson',
    description: 'wilson runner — doctor, board and card commands',
    version: '0.0.1',
    commands: [
        reg(['board', 'init'], boardInitCommand),
        reg(['board', 'import'], boardImportCommand),
        reg(['card', 'list'], cardListCommand),
        reg(['card', 'ack'], cardAckCommand),
        reg(['card', 'approve'], cardApproveCommand),
        reg(['card', 'create'], cardCreateCommand),
        reg(['card', 'depend'], cardDependCommand),
        reg(['card', 'edit'], cardEditCommand),
        reg(['card', 'show'], cardShowCommand),
        reg(['card', 'move'], cardMoveCommand),
        reg(['card', 'next'], cardNextCommand),
        reg(['card', 'plan'], cardPlanCommand),
        reg(['card', 'release'], cardReleaseCommand),
        reg(['card', 'split'], cardSplitCommand),
        reg(['card', 'start'], cardStartCommand),
        reg(['card', 'versions'], cardVersionsCommand),
    ],
    checks: [
        nodeVersion({ min: 22 }),
        envFile({ path: 'apps/api/.env', required: ['DATABASE_HOST', 'DATABASE_NAME', 'PROJECT_CODE_ROOT', 'PROJECT_BOARD_ROOT'] }),
        dockerServicesUp({ autoStart: true }),
        postgresReachable,
        queueReachable,
        providerKeySet,
        codeRepoReady,
        boardReady,
        daemonCurrent,
    ],
});

process.exit(await app.run(process.argv));
