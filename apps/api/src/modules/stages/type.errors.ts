/** One error a type checker printed. `scope` is the package a build tool's log prefix named, if any. */
export interface TypeErrorEntry {
    scope?: string;
    file: string;
    line?: number;
    column?: number;
    code: string;
    message: string;
}

/** One distinct error this tree has more of than its base, with where this tree reports it. */
export interface NetNewTypeError {
    scope?: string;
    file: string;
    code: string;
    message: string;
    /** Every place this tree reports it, new or not: identical errors cannot be told apart. */
    locations: string[];
    /** How many more this tree has than its base. */
    added: number;
}

// Colour is off when output is not a terminal, but a lane's command can ask for it anyway.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
/** `@wilson/api:typecheck: `, the prefix turbo puts on each line of a package's output. */
const TURBO_PREFIX = /^(\S+):[\w.-]+:\s+/;
/** `src/x.ts(3,7): error TS2322: ...`, what tsc prints when it is not asked for `--pretty`. */
const PLAIN_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
/** `src/x.ts:3:7 - error TS2322: ...`, what it prints when it is. */
const PRETTY_ERROR = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
/** `error TS5083: Cannot read file ...`, which has no file to blame. */
const GLOBAL_ERROR = /^error (TS\d+): (.*)$/;

/**
 * The errors in a type checker's output. Continuation lines are dropped, since the first line says
 * what is wrong and the rest are a stack of type names.
 *
 * `root` is the tree the command ran in, removed wherever it appears: a message can quote an absolute
 * `import("...")` path, and the same error in two trees must read the same.
 */
export const parseTypeErrors = (output: string, root?: string): TypeErrorEntry[] => {
    const errors: TypeErrorEntry[] = [];
    for (const raw of output.split('\n')) {
        let line = raw.replace(ANSI_ESCAPE, '').trimEnd();
        if (root) line = line.split(`${root}/`).join('');

        let scope: string | undefined;
        const prefix = TURBO_PREFIX.exec(line);
        if (prefix) {
            scope = prefix[1];
            line = line.slice(prefix[0].length);
        }

        const located = PLAIN_ERROR.exec(line) ?? PRETTY_ERROR.exec(line);
        if (located) {
            errors.push({
                ...(scope ? { scope } : {}),
                file: located[1]!,
                line: Number(located[2]),
                column: Number(located[3]),
                code: located[4]!,
                message: located[5]!,
            });
            continue;
        }
        const global = GLOBAL_ERROR.exec(line);
        if (global) errors.push({ ...(scope ? { scope } : {}), file: '', code: global[1]!, message: global[2]! });
    }
    return errors;
};

const errorKey = (error: TypeErrorEntry): string => JSON.stringify([error.scope ?? '', error.file, error.code, error.message]);

/**
 * What `head` reports that `base` does not, by package, file, code and message and never by line
 * number, so an existing error that an edit above it pushed down the file is not new. Counted, not
 * set-wise: a second identical error in a file is new even though the first was already there.
 */
export const netNewTypeErrors = (head: TypeErrorEntry[], base: TypeErrorEntry[]): NetNewTypeError[] => {
    const baseCounts = new Map<string, number>();
    for (const error of base) baseCounts.set(errorKey(error), (baseCounts.get(errorKey(error)) ?? 0) + 1);

    const groups = new Map<string, TypeErrorEntry[]>();
    for (const error of head) groups.set(errorKey(error), [...(groups.get(errorKey(error)) ?? []), error]);

    const netNew: NetNewTypeError[] = [];
    for (const [key, errors] of groups) {
        const added = errors.length - (baseCounts.get(key) ?? 0);
        if (added <= 0) continue;
        const { scope, file, code, message } = errors[0]!;
        netNew.push({
            ...(scope ? { scope } : {}),
            file,
            code,
            message,
            locations: errors.flatMap(error => (error.line !== undefined ? [`${error.line}:${error.column}`] : [])),
            added,
        });
    }
    return netNew;
};
