import { isAbsolute } from 'node:path';
import { Injectable } from 'injectkit';
import { httpError } from '@maroonedsoftware/errors';
import type { ClaudeConfigDirSetting, SetClaudeConfigDirSettingRequest } from '#src/generated/settings.js';
import { SettingsStore } from './settings.store.js';
import { CLAUDE_CONFIG_DIR } from './claude.config.dir.setting.js';

/**
 * Where the engine's Claude Code credentials come from (card 0141) — an operator's choice now,
 * instead of whatever the daemon user's own `~/.claude` happens to hold.
 *
 * `set` only validates and persists, the same as `CardStageConcurrencySettingService`: there is
 * nothing running to push this into. `subscriptionEnv` (`modules/agent/cli.stage.agent.ts`) reads
 * the setting fresh for every stage it starts, so a write here takes effect for the next stage a
 * card starts, never one already running — the field's own description in the app says so.
 */
@Injectable()
export class ClaudeConfigDirSettingService {
    constructor(private readonly settings: SettingsStore) {}

    /** The contract-facing read: the setting's current effective value, `null` where unset. */
    async get(): Promise<ClaudeConfigDirSetting> {
        const configDir = await this.settings.get(CLAUDE_CONFIG_DIR);
        return { configDir: configDir ?? null };
    }

    /**
     * The contract-facing write: refuse a relative path with a sentence naming what was wrong (the
     * same refusal `curl` and the settings page both see), otherwise persist it. Whether the
     * directory exists, is writable, or holds working credentials is deliberately not checked here
     * (this card's Out of scope) — that only ever surfaces as every `cli`-adapter stage failing at
     * the model call.
     */
    async set(body: SetClaudeConfigDirSettingRequest): Promise<ClaudeConfigDirSetting> {
        if (body.configDir !== null && !isAbsolute(body.configDir)) {
            throw httpError(400).withDetails({
                reason: `claude config directory must be an absolute path, got "${body.configDir}"`,
            });
        }
        await this.settings.set(CLAUDE_CONFIG_DIR, body.configDir ?? undefined);
        return { configDir: body.configDir };
    }
}
