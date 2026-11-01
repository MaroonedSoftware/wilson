import { JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import { CardJobs } from '../card.jobs.js';

/** What a pre-dispatch check is allowed to reach. The job's own dependencies, minus the dispatcher. */
export interface PreDispatchDeps {
    board: BoardConfig;
    boardRepo: BoardRepository;
    events: EventLog;
    cardJobs: CardJobs;
    stageConfigs: StageConfigStore;
    broker: JobBroker;
    settings: SettingsStore;
}

/**
 * A question asked before `StageDispatcher.run` cuts a worktree.
 *
 * Returns `true` to stop the dispatch — in which case the check has already recorded why and
 * released the card's claim, because only it knows what its own refusal means. Returns `false` to
 * let the dispatch proceed, which is what a check that only observes always does.
 *
 * `holdWhileDraining` keeps the card's claim by handing it to the job it re-sends: the card is still
 * being carried, just not by this job.
 *
 * Every one of these is best-effort by construction: a check that throws takes the whole job with
 * it, and `dispatcher.run` below reads the same board and the same stage config and reports a
 * genuine problem with either through its own, already-covered error handling. A check exists to
 * stop a dispatch early, never to become a second and less complete place for it to fail.
 */
export type PreDispatchCheck = (deps: PreDispatchDeps, cardId: string, stageName: string) => Promise<boolean>;
