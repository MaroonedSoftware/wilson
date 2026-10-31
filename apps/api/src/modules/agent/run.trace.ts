/** The most distinct paths a run's trace names. */
const MAX_TRACED_PATHS = 50;
/** The most of a run's final message its trace keeps. */
const MAX_TRACED_MESSAGE_CHARS = 2000;

/**
 * What a run read and the last thing it said: the part of "why did this run do that" the event log
 * does not otherwise hold. Bounded, because it rides on the stage's end event, and reads get no
 * events of their own (`card.event.ts`).
 */
export interface RunTrace {
    /** Every read, grep and glob the run made, including those past the path limit. */
    reads: number;
    /** The distinct paths it read, in the order it first read them. */
    readPaths: string[];
    /** The run's last assistant text, cut to the limit. Absent when it said nothing. */
    finalMessage?: string;
}

/**
 * `reads` holds one entry per read tool call: its path, or `undefined` for a call that has none,
 * such as a glob.
 */
export const buildRunTrace = (reads: readonly (string | undefined)[], finalMessage: string | undefined): RunTrace => {
    const paths = reads.filter((path): path is string => Boolean(path));
    return {
        reads: reads.length,
        readPaths: [...new Set(paths)].slice(0, MAX_TRACED_PATHS),
        ...(finalMessage ? { finalMessage: finalMessage.slice(0, MAX_TRACED_MESSAGE_CHARS) } : {}),
    };
};
