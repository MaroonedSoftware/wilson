import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import { CARD_STAGE_CONCURRENCY_MAX, CARD_STAGE_CONCURRENCY_MIN } from '#modules/jobs/job.runner.config.js';
import type { CardStageConcurrency, SetCardStageConcurrencyRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { CARD_STAGE_CONCURRENCY } from './card.stage.concurrency.setting.js';

/**
 * How many `card.stage` jobs this daemon runs at once.
 *
 * `set` only validates and persists — unlike `PollerSettingService`/`PollerIntervalSettingService`,
 * there is deliberately nothing here that reaches into the running process: pg-boss fixes a queue's
 * worker concurrency at `pgboss.work()` time, so this write cannot be pushed into effect the way
 * the poller's setting-of-two can. `BoundedCardStageJobRunner` (jobs.module.ts) is what notices the
 * row changed and applies it — only once every `card.stage` job this process is running has
 * finished, never before. See that class's doc for the full reasoning.
 */
@Injectable()
export class CardStageConcurrencySettingService {
    constructor(private readonly settings: SettingsStore) {}

    /** The contract-facing read: the setting's current effective value. */
    async get(): Promise<CardStageConcurrency> {
        return { concurrency: await this.settings.get(CARD_STAGE_CONCURRENCY) };
    }

    /**
     * The contract-facing write: refuse an out-of-range value with a sentence (the same refusal
     * `curl` and the settings page both see), otherwise persist it.
     */
    async set(body: SetCardStageConcurrencyRequest): Promise<CardStageConcurrency> {
        if (body.concurrency < CARD_STAGE_CONCURRENCY_MIN || body.concurrency > CARD_STAGE_CONCURRENCY_MAX) {
            throw httpError(400).withDetails({
                reason: `card stage concurrency must be between ${CARD_STAGE_CONCURRENCY_MIN} and ${CARD_STAGE_CONCURRENCY_MAX}`,
            });
        }
        await this.settings.set(CARD_STAGE_CONCURRENCY, body.concurrency);
        return { concurrency: body.concurrency };
    }
}
