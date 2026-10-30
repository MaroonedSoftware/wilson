import type { ColumnType } from 'kysely';
import type { DateTime } from 'luxon';

/**
 * A `timestamptz` column, for kysely-codegen's `typeMapping`.
 *
 * KyselyPgTypeOverrides parses timestamptz into a Luxon DateTime, not a JS Date. Declaring it as
 * Date compiles and then fails at runtime on `.toISOString()`. Writes also take a string, because
 * callers pass ISO timestamps and `sql` expressions as well as DateTimes.
 */
export type Timestamptz = ColumnType<DateTime, DateTime | string, DateTime | string>;
