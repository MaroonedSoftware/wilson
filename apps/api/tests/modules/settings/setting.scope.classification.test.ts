import { describe, expect, it } from 'vitest';
import { CARD_STAGE_CONCURRENCY } from '#modules/settings/card.stage.concurrency.setting.js';
import { CLAUDE_CONFIG_DIR } from '#modules/settings/claude.config.dir.setting.js';
import { DRY_RUN_ENABLED } from '#modules/settings/dry.run.setting.js';
import { ENGINE_TOKEN } from '#modules/settings/engine.token.setting.js';
import { NOTIFY_BASE_URL } from '#modules/settings/notify.base.url.setting.js';
import { NOTIFY_WEBHOOK_URL } from '#modules/settings/notify.webhook.url.setting.js';
import { POLLER_ENABLED } from '#modules/settings/poller.enabled.setting.js';
import { POLLER_INTERVAL_MS } from '#modules/settings/poller.interval.setting.js';

/**
 * Card 0152. `SettingDefinition.scope` is new: before this card `SettingsStore` always keyed a row
 * by the current project, so nothing distinguished "this project's policy" from "this deployment's
 * fact". Every existing `SettingDefinition` literal now carries a `scope`, and the Constraints spell
 * out, setting by setting, which one it must be and why (each definition's own doc comment repeats
 * the reasoning). This is the classification itself, checked directly: get any one of the seven
 * wrong and a deployment-wide fact goes back to being silently forked per project, or a per-project
 * policy goes back to leaking between projects — exactly the bug this card exists to fix.
 */
describe('SettingDefinition.scope classification', () => {
    it('claude-config-dir is deployment-scoped — one machine, one set of credentials', () => {
        expect(CLAUDE_CONFIG_DIR.scope).toBe('deployment');
    });

    it('engine-oauth-token is deployment-scoped — one machine, one set of credentials', () => {
        expect(ENGINE_TOKEN.scope).toBe('deployment');
    });

    it('card-stage-concurrency is deployment-scoped — one card.stage worker for the whole process', () => {
        expect(CARD_STAGE_CONCURRENCY.scope).toBe('deployment');
    });

    it('poller-interval-ms is deployment-scoped — one poller loop ticking every project', () => {
        expect(POLLER_INTERVAL_MS.scope).toBe('deployment');
    });

    it("dry-run-enabled is project-scoped — trust in one project's pipeline, not the machine", () => {
        expect(DRY_RUN_ENABLED.scope).toBe('project');
    });

    it("notify-webhook-url is project-scoped — where this project's notifications go", () => {
        expect(NOTIFY_WEBHOOK_URL.scope).toBe('project');
    });

    it("notify-base-url is project-scoped — decorates this project's own notifications", () => {
        expect(NOTIFY_BASE_URL.scope).toBe('project');
    });

    it('poller-enabled is project-scoped — pausing one project must not pause the others', () => {
        expect(POLLER_ENABLED.scope).toBe('project');
    });
});
