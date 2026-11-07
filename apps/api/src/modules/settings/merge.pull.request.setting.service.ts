import { Injectable } from 'injectkit';
import type { MergePullRequestSetting, SetMergePullRequestSettingRequest } from '#src/generated/settings.js';
import { MERGE_OPENS_PULL_REQUEST } from './merge.pull.request.setting.js';
import { SettingsStore } from './settings.store.js';

/**
 * The switch for landing merges as GitHub pull requests, contract-facing. `BoardWriteService.merge`
 * reads the setting on every attempt, so persisting the row is the whole job, the same posture
 * `DryRunSettingService` takes.
 */
@Injectable()
export class MergePullRequestSettingService {
    constructor(private readonly settings: SettingsStore) {}

    /** The contract-facing read: the setting's current effective value. */
    async get(): Promise<MergePullRequestSetting> {
        return { enabled: await this.settings.get(MERGE_OPENS_PULL_REQUEST) };
    }

    /** The contract-facing write: persist the new value. Nothing to validate: it is a plain switch. */
    async set(body: SetMergePullRequestSettingRequest): Promise<MergePullRequestSetting> {
        await this.settings.set(MERGE_OPENS_PULL_REQUEST, body.enabled);
        return { enabled: body.enabled };
    }
}
