import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import type { EngineAccountUsage, EngineAccountUsageQuery } from '../../generated/engine.tokens.js';
import { EngineUsageRepository } from './engine.usage.repository.js';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** `GET /api/engine-accounts/usage`: what each engine account spent, over the same kind of window as `GET /api/stats`. */
@Injectable()
export class EngineUsageService {
    constructor(private readonly repository: EngineUsageRepository) {}

    /** Each account's spend over its last `days` days, today included. A day starts at the server's midnight. */
    async usage(query: EngineAccountUsageQuery): Promise<EngineAccountUsage[]> {
        const days = Math.max(1, Math.min(query.days ?? DEFAULT_DAYS, MAX_DAYS));
        const now = DateTime.now();
        const today = now.startOf('day');
        // Past the current instant, so a row written in the same millisecond is not left out.
        return this.repository.byAccount(today.minus({ days: days - 1 }), now.plus({ seconds: 1 }), today);
    }
}
