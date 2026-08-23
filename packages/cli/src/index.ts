#!/usr/bin/env node
import 'reflect-metadata';
import { createCliApp, type CommandModule, type CommandRegistration } from '@maroonedsoftware/johnny5';
import { nodeVersion } from '@maroonedsoftware/johnny5/versions';
import { envFile } from '@maroonedsoftware/johnny5/filesystem';
import { dockerServicesUp } from '@maroonedsoftware/johnny5/docker';
import { buildConfig, modules } from '@kanban/api/cli-bootstrap';

import boardInitCommand from './commands/board/init.command.js';
import cardListCommand from './commands/card/list.command.js';
import cardRunCommand from './commands/card/run.command.js';
import cardShowCommand from './commands/card/show.command.js';

import { boardRepoReady } from './checks/board.repo.js';
import { codeRepoReady } from './checks/code.repo.js';
import { postgresReachable } from './checks/postgres.reachable.js';
import { providerKeySet } from './checks/provider.key.js';

// johnny5's `CommandRegistration.module` is typed as `CommandModule<Record<string, unknown>>`, but
// command files declare narrow `*Opts` interfaces so their `run` bodies stay type-safe. `reg()` is
// the single cast surface where the per-command opts widen back to the registry shape.
const reg = <O>(path: string[], module: CommandModule<O>): CommandRegistration => ({
    path,
    module: module as unknown as CommandModule,
});

const app = await createCliApp({
    name: 'wizard',
    description: 'kanban runner — doctor, board and card commands',
    version: '0.0.1',
    config: buildConfig,
    // ServerKitModule's setup/start take a concrete Registry/Container; johnny5 types them as
    // `unknown` to avoid forcing the injectkit import. The runtime contract matches.
    modules: modules as unknown as Parameters<typeof createCliApp>[0]['modules'],
    commands: [
        reg(['board', 'init'], boardInitCommand),
        reg(['card', 'list'], cardListCommand),
        reg(['card', 'show'], cardShowCommand),
        reg(['card', 'run'], cardRunCommand),
    ],
    checks: [
        nodeVersion({ min: 22 }),
        envFile({ path: 'apps/api/.env', required: ['DATABASE_HOST', 'DATABASE_NAME', 'PROJECT_CODE_ROOT', 'PROJECT_BOARD_ROOT'] }),
        dockerServicesUp({ autoStart: true }),
        postgresReachable,
        providerKeySet,
        codeRepoReady,
        boardRepoReady,
    ],
});

process.exit(await app.run(process.argv));
