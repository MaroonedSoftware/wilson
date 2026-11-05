import { Injectable } from 'injectkit';
// A value import, not `import type`: `@Injectable()`'s `design:paramtypes` metadata has to name
// `Kysely` as a value, the reason `EngineLimitRepository` gives for the same line.
import { Kysely, sql } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';

/** What one engine account spent over a window, with its output since `today`. */
export interface EngineAccountUsageRow {
    account: string;
    todayOutputTokens: number;
    outputTokens: number;
    /** Includes `cachedInputTokens`, as `EventLog.projectStats` counts it. */
    inputTokens: number;
    cachedInputTokens: number;
}

/** The stage events that carry a run's `usage`, as `EventLog.projectStats` reads them, less the rule judge's, which name no account. */
const STAGE_END_EVENTS = ['stage.passed', 'stage.failed', 'stage.interrupted', 'stage.blocked'] as const;

/**
 * Spend by engine account, across every project, from the three places spend is recorded: stage end
 * events (`payload.account` beside `payload.usage`), `wilson.chat_turn_usage` and `wilson.plan_turns`.
 * Rows that name no account are left out, since there is nothing to charge them to.
 */
@Injectable()
export class EngineUsageRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Every account that spent anything from `since` up to `until`, most output first. `today` is where today's output starts. */
    async byAccount(since: DateTime, until: DateTime, today: DateTime): Promise<EngineAccountUsageRow[]> {
        const stages = this.db
            .selectFrom('wilson.cardEvents')
            .where('type', 'in', STAGE_END_EVENTS)
            .where(sql<boolean>`payload ? 'account'`)
            .where('createdAt', '>=', since)
            .where('createdAt', '<', until)
            .select([
                sql<string>`payload->>'account'`.as('account'),
                'createdAt',
                sql<string>`coalesce((payload->'usage'->>'outputTokens')::bigint, 0)`.as('output'),
                sql<string>`coalesce((payload->'usage'->>'inputTokens')::bigint, 0) + coalesce((payload->'usage'->>'cachedInputTokens')::bigint, 0)`.as(
                    'input',
                ),
                sql<string>`coalesce((payload->'usage'->>'cachedInputTokens')::bigint, 0)`.as('cached'),
            ]);
        // A turn's `input_tokens` leaves out what the cache served, as a stage's does, so both are added.
        const chats = this.db
            .selectFrom('wilson.chatTurnUsage')
            .where('account', 'is not', null)
            .where('createdAt', '>=', since)
            .where('createdAt', '<', until)
            .select([
                sql<string>`account`.as('account'),
                'createdAt',
                sql<string>`output_tokens::bigint`.as('output'),
                sql<string>`(coalesce(input_tokens, 0) + coalesce(cached_input_tokens, 0))::bigint`.as('input'),
                sql<string>`coalesce(cached_input_tokens, 0)::bigint`.as('cached'),
            ]);
        const plans = this.db
            .selectFrom('wilson.planTurns')
            .where('role', '=', 'assistant')
            .where('account', 'is not', null)
            .where('createdAt', '>=', since)
            .where('createdAt', '<', until)
            .select([
                sql<string>`account`.as('account'),
                'createdAt',
                sql<string>`coalesce(output_tokens, 0)::bigint`.as('output'),
                sql<string>`(coalesce(input_tokens, 0) + coalesce(cached_input_tokens, 0))::bigint`.as('input'),
                sql<string>`coalesce(cached_input_tokens, 0)::bigint`.as('cached'),
            ]);

        const rows = await this.db
            .selectFrom(stages.unionAll(chats).unionAll(plans).as('spend'))
            .select([
                'account',
                sql<string>`coalesce(sum(output) filter (where created_at >= ${today}), 0)`.as('todayOutputTokens'),
                sql<string>`sum(output)`.as('outputTokens'),
                sql<string>`sum(input)`.as('inputTokens'),
                sql<string>`sum(cached)`.as('cachedInputTokens'),
            ])
            .groupBy('account')
            .orderBy(sql`sum(output)`, 'desc')
            .orderBy('account')
            .execute();

        return rows.map(row => ({
            account: row.account,
            todayOutputTokens: Number(row.todayOutputTokens),
            outputTokens: Number(row.outputTokens),
            inputTokens: Number(row.inputTokens),
            cachedInputTokens: Number(row.cachedInputTokens),
        }));
    }
}
