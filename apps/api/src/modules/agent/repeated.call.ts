/**
 * How many identical calls, with nothing written since, count as a loop.
 *
 * High enough that a stage re-reading its plan or re-running a flaky test a few times is left alone,
 * since a false stop costs a whole retry. Low enough to stop well short of the budgets, which is the
 * point: those run for as long as they allow and then blame themselves.
 */
export const REPEATED_CALL_LIMIT = 8;

/** A call a run has repeated too often. `input` is its canonical JSON. */
export interface RepeatedCall {
    tool: string;
    input: string;
    count: number;
}

/** JSON with object keys sorted, so the order an engine happened to write them in says nothing. */
const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
};

/**
 * Watches a run's tool calls for the same call over and over. Nothing here ends the run: the adapter
 * that owns the engine asks `loop` and decides how to stop it.
 *
 * Calls count wherever they fall since the last write, not only back to back, so alternating between
 * two calls is still seen. A successful write clears the count, because the same command against a
 * changed tree is a new question: re-running the tests after an edit is the work, not a loop. A write
 * identical to the last one changed nothing, so it clears nothing and counts like any other call. A
 * refused or failed write clears nothing either, which is how a run retrying a denied write gets caught.
 *
 * A write made through a shell command looks like any other command here.
 */
export class RepeatedCallWatch {
    private readonly counts = new Map<string, number>();
    private lastWrite?: string;
    private seen?: RepeatedCall;

    observe(tool: string, input: unknown): void {
        const canonical = canonicalJson(input);
        const key = `${tool}\0${canonical}`;
        const count = (this.counts.get(key) ?? 0) + 1;
        this.counts.set(key, count);
        if (count >= REPEATED_CALL_LIMIT) this.seen ??= { tool, input: canonical, count };
    }

    /** A write has succeeded, with the same `tool` and `input` it was observed with. */
    wrote(tool: string, input: unknown): void {
        const key = `${tool}\0${canonicalJson(input)}`;
        if (key === this.lastWrite) return;
        this.lastWrite = key;
        this.counts.clear();
    }

    /** The call this run has repeated too often, if it has. It stays set, whatever is written after. */
    get loop(): RepeatedCall | undefined {
        return this.seen;
    }
}

/** How much of a repeated call's input a failure quotes, leaving room for the rest in an attempt's bullet. */
const MAX_INPUT_QUOTED = 100;

/** A stopped loop as a person, or the next attempt, reads it. Names no budget, since none ran out. */
export const describeRepeatedCall = ({ tool, input, count }: RepeatedCall): string => {
    const quoted = input.length > MAX_INPUT_QUOTED ? `${input.slice(0, MAX_INPUT_QUOTED)}…` : input;
    return `stopped in a loop: made the same ${tool} call ${count} times with nothing written between them, ${quoted}`;
};
