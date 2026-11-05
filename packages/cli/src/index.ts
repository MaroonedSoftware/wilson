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
// no `config`/`modules` wiring and this file has no `@wilson/api` import left. `ctx.config` is
// johnny5's own bare default — a resolver with no source, so it returns nothing for every key
// regardless of `apps/api/.env`. Settings come from `ctx.env` instead (see `settings.ts`), which
// `buildContext`'s default `envFiles` (already including `apps/api/.env`) does populate.
import authLoginCommand from './commands/auth/login.command.js';
import authLogoutCommand from './commands/auth/logout.command.js';
import authStatusCommand from './commands/auth/status.command.js';
import authTokenCommand from './commands/auth/token.command.js';
import boardInitCommand from './commands/board/init.command.js';
import cardListCommand from './commands/card/list.command.js';
import cardAckCommand from './commands/card/ack.command.js';
import cardAnswerCommand from './commands/card/answer.command.js';
import cardApproveCommand from './commands/card/approve.command.js';
import cardCreateCommand from './commands/card/create.command.js';
import cardDependCommand from './commands/card/depend.command.js';
import cardDiffCommand from './commands/card/diff.command.js';
import cardEditCommand from './commands/card/edit.command.js';
import cardLintCommand from './commands/card/lint.command.js';
import cardMergeCommand from './commands/card/merge.command.js';
import cardMoveCommand from './commands/card/move.command.js';
import cardNextCommand from './commands/card/next.command.js';
import cardPlanCommand from './commands/card/plan.command.js';
import cardReleaseCommand from './commands/card/release.command.js';
import cardRenameCommand from './commands/card/rename.command.js';
import cardShowCommand from './commands/card/show.command.js';
import cardSplitCommand from './commands/card/split.command.js';
import cardStartCommand from './commands/card/start.command.js';
import cardVersionsCommand from './commands/card/versions.command.js';
import engineTokenListCommand from './commands/engine-token/list.command.js';
import engineTokenRemoveCommand from './commands/engine-token/remove.command.js';
import engineTokenSetCommand from './commands/engine-token/set.command.js';
import engineTokenUpdateCommand from './commands/engine-token/update.command.js';
import hostAddCommand from './commands/host/add.command.js';
import hostEngineTokenCommand from './commands/host/engine-token.command.js';
import hostIsolatedCommand from './commands/host/isolated.command.js';
import hostListCommand from './commands/host/list.command.js';
import hostProbeCommand from './commands/host/probe.command.js';
import hostRemoveCommand from './commands/host/remove.command.js';
import hostServeCommand from './commands/host/serve.command.js';
import hostSetCommand from './commands/host/set.command.js';
import hostTokenCommand from './commands/host/token.command.js';
import hostUnserveCommand from './commands/host/unserve.command.js';
import projectCreateCommand from './commands/project/create.command.js';
import secretListCommand from './commands/secret/list.command.js';
import secretRemoveCommand from './commands/secret/remove.command.js';
import secretSetCommand from './commands/secret/set.command.js';
import serverDrainCommand from './commands/server/drain.command.js';
import serverResumeCommand from './commands/server/resume.command.js';
import serverStatusCommand from './commands/server/status.command.js';
import stagesShowCommand from './commands/stages/show.command.js';
import stagesSetCommand from './commands/stages/set.command.js';
import stagesRouteCommand from './commands/stages/route.command.js';
import stagesInstructionsCommand from './commands/stages/instructions.command.js';
import stagesHistoryCommand from './commands/stages/history.command.js';
import evalListCommand from './commands/eval/list.command.js';
import evalPatchCommand from './commands/eval/patch.command.js';
import evalRunCommand from './commands/eval/run.command.js';
import evalShowCommand from './commands/eval/show.command.js';
import evalStopCommand from './commands/eval/stop.command.js';
import evalFixtureAddCommand from './commands/eval/fixture-add.command.js';
import evalFixtureLabelCommand from './commands/eval/fixture-label.command.js';
import evalFixtureListCommand from './commands/eval/fixture-list.command.js';
import evalFixtureRemoveCommand from './commands/eval/fixture-remove.command.js';
import learningsShowCommand from './commands/learnings/show.command.js';
import learningsEditCommand from './commands/learnings/edit.command.js';
import learningsSetCommand from './commands/learnings/set.command.js';
import learningsVersionsCommand from './commands/learnings/versions.command.js';
import rulesListCommand from './commands/rules/list.command.js';
import rulesAddCommand from './commands/rules/add.command.js';
import rulesEditCommand from './commands/rules/edit.command.js';
import rulesRmCommand from './commands/rules/rm.command.js';
import rulesCheckCommand from './commands/rules/check.command.js';
import rulesRouteCommand from './commands/rules/route.command.js';
import rulesProposalsCommand from './commands/rules/proposals.command.js';
import rulesAcceptCommand from './commands/rules/accept.command.js';
import rulesDeclineCommand from './commands/rules/decline.command.js';

import { apiSignedIn } from './checks/api.signed.in.js';
import { boardReady } from './checks/board.ready.js';
import { daemonCurrent } from './checks/daemon.current.js';
import { serverNotDraining } from './checks/server.not.draining.js';
import { claudeBinaryCurrent } from './checks/claude.binary.current.js';
import { codeRepoReady } from './checks/code.repo.js';
import { postgresReachable } from './checks/postgres.reachable.js';
import { databaseBackedUp } from './checks/database.backed.up.js';
import { testDbMigrated } from './checks/test.db.migrated.js';
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
        reg(['auth', 'login'], authLoginCommand),
        reg(['auth', 'logout'], authLogoutCommand),
        reg(['auth', 'status'], authStatusCommand),
        reg(['auth', 'token'], authTokenCommand),
        reg(['board', 'init'], boardInitCommand),
        reg(['card', 'list'], cardListCommand),
        reg(['card', 'ack'], cardAckCommand),
        reg(['card', 'answer'], cardAnswerCommand),
        reg(['card', 'approve'], cardApproveCommand),
        reg(['card', 'create'], cardCreateCommand),
        reg(['card', 'depend'], cardDependCommand),
        reg(['card', 'diff'], cardDiffCommand),
        reg(['card', 'edit'], cardEditCommand),
        reg(['card', 'lint'], cardLintCommand),
        reg(['card', 'merge'], cardMergeCommand),
        reg(['card', 'rename'], cardRenameCommand),
        reg(['card', 'show'], cardShowCommand),
        reg(['card', 'move'], cardMoveCommand),
        reg(['card', 'next'], cardNextCommand),
        reg(['card', 'plan'], cardPlanCommand),
        reg(['card', 'release'], cardReleaseCommand),
        reg(['card', 'split'], cardSplitCommand),
        reg(['card', 'start'], cardStartCommand),
        reg(['card', 'versions'], cardVersionsCommand),
        reg(['project', 'create'], projectCreateCommand),
        reg(['host', 'add'], hostAddCommand),
        reg(['host', 'list'], hostListCommand),
        reg(['host', 'set'], hostSetCommand),
        reg(['host', 'remove'], hostRemoveCommand),
        reg(['host', 'serve'], hostServeCommand),
        reg(['host', 'unserve'], hostUnserveCommand),
        reg(['host', 'token'], hostTokenCommand),
        reg(['host', 'engine-token'], hostEngineTokenCommand),
        reg(['host', 'isolated'], hostIsolatedCommand),
        reg(['engine-token', 'list'], engineTokenListCommand),
        reg(['engine-token', 'set'], engineTokenSetCommand),
        reg(['engine-token', 'update'], engineTokenUpdateCommand),
        reg(['engine-token', 'remove'], engineTokenRemoveCommand),
        reg(['secret', 'list'], secretListCommand),
        reg(['secret', 'set'], secretSetCommand),
        reg(['secret', 'remove'], secretRemoveCommand),
        reg(['host', 'probe'], hostProbeCommand),
        reg(['server', 'drain'], serverDrainCommand),
        reg(['server', 'resume'], serverResumeCommand),
        reg(['server', 'status'], serverStatusCommand),
        reg(['stages', 'show'], stagesShowCommand),
        reg(['stages', 'set'], stagesSetCommand),
        reg(['stages', 'route'], stagesRouteCommand),
        reg(['stages', 'instructions'], stagesInstructionsCommand),
        reg(['stages', 'history'], stagesHistoryCommand),
        reg(['eval', 'run'], evalRunCommand),
        reg(['eval', 'list'], evalListCommand),
        reg(['eval', 'show'], evalShowCommand),
        reg(['eval', 'stop'], evalStopCommand),
        reg(['eval', 'patch'], evalPatchCommand),
        reg(['eval', 'fixture', 'add'], evalFixtureAddCommand),
        reg(['eval', 'fixture', 'label'], evalFixtureLabelCommand),
        reg(['eval', 'fixture', 'list'], evalFixtureListCommand),
        reg(['eval', 'fixture', 'rm'], evalFixtureRemoveCommand),
        reg(['learnings', 'show'], learningsShowCommand),
        reg(['learnings', 'edit'], learningsEditCommand),
        reg(['learnings', 'set'], learningsSetCommand),
        reg(['learnings', 'versions'], learningsVersionsCommand),
        reg(['rules', 'list'], rulesListCommand),
        reg(['rules', 'add'], rulesAddCommand),
        reg(['rules', 'edit'], rulesEditCommand),
        reg(['rules', 'rm'], rulesRmCommand),
        reg(['rules', 'check'], rulesCheckCommand),
        reg(['rules', 'route'], rulesRouteCommand),
        reg(['rules', 'proposals'], rulesProposalsCommand),
        reg(['rules', 'accept'], rulesAcceptCommand),
        reg(['rules', 'decline'], rulesDeclineCommand),
    ],
    checks: [
        nodeVersion({ min: 22 }),
        envFile({ path: 'apps/api/.env', required: ['DATABASE_HOST', 'DATABASE_NAME', 'PROJECT_CODE_ROOT'] }),
        dockerServicesUp({ autoStart: true }),
        postgresReachable,
        databaseBackedUp,
        testDbMigrated,
        queueReachable,
        providerKeySet,
        codeRepoReady,
        apiSignedIn,
        boardReady,
        daemonCurrent,
        serverNotDraining,
        claudeBinaryCurrent,
    ],
});

process.exit(await app.run(process.argv));
