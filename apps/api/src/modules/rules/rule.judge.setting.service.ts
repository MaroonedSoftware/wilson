import { httpError } from '@maroonedsoftware/errors';
import { Injectable } from 'injectkit';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { RuleJudgeSetting } from '#src/generated/settings.js';
import { invalidRuleJudgeRoute, RULE_JUDGE_ROUTE } from './rule.judge.setting.js';

/** The `rule-judge` setting's contract surface (`settings.ck`). See `rule.judge.setting.ts`. */
@Injectable()
export class RuleJudgeSettingService {
    constructor(private readonly settings: SettingsStore) {}

    async get(): Promise<RuleJudgeSetting> {
        return this.settings.get(RULE_JUDGE_ROUTE);
    }

    async set(body: RuleJudgeSetting): Promise<RuleJudgeSetting> {
        const route = { ...body, model: body.model.trim() };
        const invalid = invalidRuleJudgeRoute(route);
        if (invalid) throw httpError(400).withDetails({ reason: invalid });
        await this.settings.set(RULE_JUDGE_ROUTE, route);
        return route;
    }
}
