import { Injectable } from 'injectkit';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import type { DrainStatus, SetDrainRequest } from '#src/generated/settings.js';
import { DRAIN_ENABLED } from './drain.enabled.setting.js';
import { SettingsStore } from './settings.store.js';

/**
 * Reads and writes `DRAIN_ENABLED`, and says whether a restart is safe yet.
 *
 * A write has nothing to push to: `holdWhileDraining` and `Poller.tick` both read the setting fresh,
 * so unlike `PollerSettingService` nothing here starts or stops anything.
 *
 * `RunningCards` is this process's view, which is the right one: a restart ends this process, and
 * stages placed on a worker are still run from here.
 */
@Injectable()
export class DrainSettingService {
    constructor(
        private readonly settings: SettingsStore,
        private readonly running: RunningCards,
        private readonly cardJobs: CardJobs,
    ) {}

    /** The contract-facing read. */
    async get(): Promise<DrainStatus> {
        const draining = await this.settings.get(DRAIN_ENABLED);
        const running = this.running.snapshot().map(({ project, cardId }) => ({ project, cardId }));
        const { held, planDrafts } = await this.cardJobs.drainCounts();

        return { draining, running, held, planDrafts, safeToRestart: draining && running.length === 0 && planDrafts === 0 };
    }

    /** The contract-facing write. */
    async set(body: SetDrainRequest): Promise<DrainStatus> {
        await this.settings.set(DRAIN_ENABLED, body.draining);
        return this.get();
    }
}
