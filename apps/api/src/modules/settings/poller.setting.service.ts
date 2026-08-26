import { Injectable } from 'injectkit';
import { Poller } from '#modules/jobs/poller.js';
import type { PollerSetting, SetPollerSettingRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { POLLER_ENABLED } from './poller.enabled.setting.js';

/**
 * The poller's on/off switch, live: a write here reaches the running `Poller` immediately — no
 * restart, and (`Poller.stop()`'s own contract, unchanged by this) no effect on a stage already
 * running, since this only ever starts or stops the poller's own enqueue loop.
 *
 * `Poller` is registered unconditionally now (`jobs.module.ts`); what used to be a one-time,
 * boot-only decision in `JobsModule.setup` (`POLLER_ENABLED`, read once via `configBoolean`) is
 * this class instead — askable, and appliable, again at any point in the process's life.
 */
@Injectable()
export class PollerSettingService {
    constructor(
        private readonly settings: SettingsStore,
        private readonly poller: Poller,
    ) {}

    /** The contract-facing read: the setting's current effective value. */
    async get(): Promise<PollerSetting> {
        return { enabled: await this.settings.get(POLLER_ENABLED) };
    }

    /** The contract-facing write: persist the new value, then apply it immediately. */
    async set(body: SetPollerSettingRequest): Promise<PollerSetting> {
        await this.settings.set(POLLER_ENABLED, body.enabled);
        return this.applyCurrentValue();
    }

    /**
     * Start or stop the poller to match whatever the setting currently resolves to.
     *
     * Called both from `set` above (after a write) and from `BoundedCardStageJobRunner.start()`
     * (`jobs.module.ts`), so a database row or `POLLER_ENABLED` already takes effect at boot the
     * same way a later write does — one code path decides "should the poller be running", asked
     * twice rather than answered two different ways.
     *
     * Safe to call repeatedly with an unchanged value: `Poller.start()` and `Poller.stop()` are
     * already idempotent (see `poller.ts`), so this never starts a second timer.
     */
    async applyCurrentValue(): Promise<PollerSetting> {
        const enabled = await this.settings.get(POLLER_ENABLED);
        if (enabled) {
            this.poller.start();
        } else {
            await this.poller.stop();
        }
        return { enabled };
    }
}
