import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { POLLER_INTERVAL_MS_MAX, POLLER_INTERVAL_MS_MIN } from '#modules/jobs/job.runner.config.js';
import type { PollerInterval, SetPollerIntervalRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { POLLER_INTERVAL_MS } from './poller.interval.setting.js';

/**
 * How often the poller checks the board — card 0115's counterpart to `PollerSettingService`.
 *
 * `set` has nothing to push into a running process the way `PollerSettingService.set` pushes into
 * `Poller.start`/`stop`: `Poller.loop` (poller.ts) reads `POLLER_INTERVAL_MS` itself on every
 * iteration, so persisting the row here is already the whole job — the next tick picks it up on
 * its own.
 */
@Injectable()
export class PollerIntervalSettingService {
    constructor(private readonly settings: SettingsStore) {}

    /** The contract-facing read: the setting's current effective value. */
    async get(): Promise<PollerInterval> {
        return { intervalMs: await this.settings.get(POLLER_INTERVAL_MS) };
    }

    /**
     * The contract-facing write: refuse an out-of-range value with a sentence (the same refusal
     * `curl` and the settings page both see), otherwise persist it.
     */
    async set(body: SetPollerIntervalRequest): Promise<PollerInterval> {
        if (body.intervalMs < POLLER_INTERVAL_MS_MIN || body.intervalMs > POLLER_INTERVAL_MS_MAX) {
            throw httpError(400).withDetails({
                reason: `poller interval must be between ${POLLER_INTERVAL_MS_MIN} and ${POLLER_INTERVAL_MS_MAX} ms`,
            });
        }
        await this.settings.set(POLLER_INTERVAL_MS, body.intervalMs);
        return { intervalMs: body.intervalMs };
    }
}
