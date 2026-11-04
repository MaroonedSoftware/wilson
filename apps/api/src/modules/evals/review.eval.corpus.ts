import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ReviewEvalTruthSchema, type ReviewEvalTruth } from './review.eval.score.js';

/**
 * The corpus behind the review measurement, read from `apps/api/evals/review/cases/<id>`:
 *
 * - `case.json`: the commit to start from, and the card's title.
 * - `plan.md`: the card body the reviewer reads.
 * - `change.patch`: the diff under review.
 * - `truth.json`: what the reviewer should find, which it never sees.
 */

const CaseFileSchema = z.object({
    /** Full sha in this repository. Its tree becomes the scratch repository's only commit. */
    base: z.string().regex(/^[0-9a-f]{40}$/),
    /** The merged commit the patch was cut from. */
    source: z.string().regex(/^[0-9a-f]{40}$/),
    title: z.string().min(1),
});

export interface ReviewEvalCase {
    id: string;
    base: string;
    source: string;
    title: string;
    plan: string;
    /** Absolute, so it can be applied from any directory. */
    patchPath: string;
    patch: string;
    truth: ReviewEvalTruth;
}

export const loadCase = async (casesDir: string, id: string): Promise<ReviewEvalCase> => {
    const dir = join(casesDir, id);
    const read = (name: string): Promise<string> => readFile(join(dir, name), 'utf8');
    const file = CaseFileSchema.parse(JSON.parse(await read('case.json')));
    return {
        id,
        ...file,
        plan: await read('plan.md'),
        patchPath: join(dir, 'change.patch'),
        patch: await read('change.patch'),
        truth: ReviewEvalTruthSchema.parse(JSON.parse(await read('truth.json'))),
    };
};

export const loadCorpus = async (casesDir: string): Promise<ReviewEvalCase[]> => {
    const entries = await readdir(casesDir, { withFileTypes: true });
    const ids = entries
        // A dot directory is some tool's, not a case.
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort();
    return Promise.all(ids.map(id => loadCase(casesDir, id)));
};

/** The lines a patch adds, by file after the patch. A deleted file has none. */
export const addedLines = (patch: string): Map<string, Set<number>> => {
    const added = new Map<string, Set<number>>();
    let current: Set<number> | undefined;
    let line = 0;
    let inHunk = false;
    for (const text of patch.split('\n')) {
        if (text.startsWith('diff --git ')) {
            current = undefined;
            inHunk = false;
        } else if (!inHunk && text.startsWith('+++ ')) {
            current = undefined;
            if (text.startsWith('+++ b/')) {
                current = new Set();
                added.set(text.slice('+++ b/'.length), current);
            }
        } else if (text.startsWith('@@ ')) {
            line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
            inHunk = true;
        } else if (inHunk) {
            if (text.startsWith('+')) {
                current?.add(line);
                line += 1;
            } else if (text.startsWith(' ')) {
                line += 1;
            }
        }
    }
    return added;
};

/** Words that would tell the reviewer what kind of case this is. */
const GIVEAWAY = /\b(seeded|planted|defect|control case|known bug)\b/i;

/**
 * What is wrong with a case, as far as its own files can say. Needs no git, so it runs where the
 * history is shallow. Whether the patch applies to its base is checked where the base exists.
 */
export const caseProblems = (evalCase: ReviewEvalCase): string[] => {
    const problems: string[] = [];
    const added = addedLines(evalCase.patch);
    if (added.size === 0) problems.push('the patch changes nothing');
    if (GIVEAWAY.test(evalCase.plan) || GIVEAWAY.test(evalCase.title)) problems.push('the plan gives away what kind of case this is');
    if (!/^## Files in scope$/m.test(evalCase.plan)) problems.push('the plan has no "Files in scope"');
    // Without it the first install rewrites the lockfile, and the verifier blames the reviewer.
    if ([...added.keys()].some(path => path.endsWith('package.json')) && !added.has('pnpm-lock.yaml')) {
        problems.push('the patch edits a package.json and leaves out pnpm-lock.yaml');
    }

    if (evalCase.truth.kind === 'defect') {
        const { file, lines } = evalCase.truth;
        const fileAdded = added.get(file);
        if (!fileAdded) {
            problems.push(`the truth names ${file}, which the patch does not add to`);
        } else {
            let touched = false;
            for (let line = lines[0]; line <= lines[1]; line++) touched ||= fileAdded.has(line);
            if (!touched) problems.push(`the truth's lines ${lines[0]}-${lines[1]} in ${file} include none the patch adds`);
        }
    }
    return problems;
};
