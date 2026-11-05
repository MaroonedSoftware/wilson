/**
 * What an eval run goes by wherever a card id is expected: its worktree, leases, events and run
 * folder. No card can have one, since card ids are numbers, so nothing on the board can see it.
 */
export const EVAL_RUN_ID_PREFIX = 'eval-';

export const evalRunId = (rowId: string): string => `${EVAL_RUN_ID_PREFIX}${rowId}`;

/** The `wilson.eval_runs` row an id names, or `undefined` for a card's id. */
export const evalRunRowId = (id: string): bigint | undefined =>
    id.startsWith(EVAL_RUN_ID_PREFIX) && /^\d+$/.test(id.slice(EVAL_RUN_ID_PREFIX.length)) ? BigInt(id.slice(EVAL_RUN_ID_PREFIX.length)) : undefined;
