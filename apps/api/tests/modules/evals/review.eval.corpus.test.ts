import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { addedLines, caseProblems, loadCorpus, type ReviewEvalCase } from '#modules/evals/review.eval.corpus.js';

const exec = promisify(execFile);
const CASES_DIR = new URL('../../../evals/review/cases/', import.meta.url).pathname;

const PATCH = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -5,3 +5,4 @@ context',
    ' keep',
    '-old',
    '+new one',
    '+new two',
    ' keep',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '',
].join('\n');

const aCase = (over: Partial<ReviewEvalCase> = {}): ReviewEvalCase => ({
    id: 'c',
    base: 'a'.repeat(40),
    source: 'b'.repeat(40),
    title: 'Do a thing',
    plan: '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n',
    patchPath: '/nowhere',
    patch: PATCH,
    truth: { kind: 'defect', class: 'logic', file: 'src/a.ts', lines: [6, 7], about: 'wrong', fixedBy: 'c'.repeat(40) },
    ...over,
});

describe('addedLines', () => {
    it('numbers added lines on the new side, skipping removed ones', () => {
        const added = addedLines(PATCH);
        expect([...added.get('src/a.ts')!]).toEqual([6, 7]);
        expect(added.has('src/gone.ts')).toBe(false);
    });

    it('does not mistake an added line that looks like a file header for one', () => {
        const patch = ['--- a/x', '+++ b/x', '@@ -0,0 +1,2 @@', '+++ b/fake', '+two', ''].join('\n');
        expect([...addedLines(patch).keys()]).toEqual(['x']);
    });
});

describe('caseProblems', () => {
    it('accepts a good case', () => {
        expect(caseProblems(aCase())).toEqual([]);
    });

    it('accepts a control with no lines to check', () => {
        expect(caseProblems(aCase({ truth: { kind: 'control', about: 'clean' } }))).toEqual([]);
    });

    it('refuses truth the patch does not add', () => {
        expect(caseProblems(aCase({ truth: { ...aCase().truth, file: 'src/other.ts' } as ReviewEvalCase['truth'] }))[0]).toContain('does not add to');
        const outOfRange: ReviewEvalCase['truth'] = {
            kind: 'defect',
            class: 'logic',
            file: 'src/a.ts',
            lines: [8, 9],
            about: 'x',
            fixedBy: 'c'.repeat(40),
        };
        expect(caseProblems(aCase({ truth: outOfRange }))[0]).toContain('include none the patch adds');
    });

    it('refuses a plan that gives the game away or has no scope', () => {
        expect(caseProblems(aCase({ plan: '## Goal\n\nA seeded defect.\n\n## Files in scope\n\n- x\n' }))[0]).toContain('gives away');
        expect(caseProblems(aCase({ plan: '## Goal\n\nDo it.\n' }))[0]).toContain('Files in scope');
    });
});

describe('loadCorpus', () => {
    it('reads case directories and skips a dot directory left by a tool', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'review-eval-cases-'));
        try {
            const caseDir = join(dir, 'a-case');
            await mkdir(caseDir);
            await mkdir(join(dir, '.claude'));
            await writeFile(join(caseDir, 'case.json'), JSON.stringify({ base: 'a'.repeat(40), source: 'b'.repeat(40), title: 'T' }));
            await writeFile(join(caseDir, 'plan.md'), 'plan');
            await writeFile(join(caseDir, 'change.patch'), PATCH);
            await writeFile(join(caseDir, 'truth.json'), JSON.stringify({ kind: 'control', about: 'clean' }));
            expect((await loadCorpus(dir)).map(evalCase => evalCase.id)).toEqual(['a-case']);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('the corpus', () => {
    it('holds 20 defects and 10 controls across several classes, every case well formed', async () => {
        const corpus = await loadCorpus(CASES_DIR);
        expect(corpus.flatMap(evalCase => caseProblems(evalCase).map(problem => `${evalCase.id}: ${problem}`))).toEqual([]);
        const defects = corpus.flatMap(evalCase => (evalCase.truth.kind === 'defect' ? [evalCase.truth] : []));
        expect(defects).toHaveLength(20);
        expect(corpus.length - defects.length).toBe(10);
        expect(new Set(defects.map(truth => truth.class)).size).toBeGreaterThanOrEqual(5);
    });

    // CI's checkout is shallow, so the bases exist only in a full clone. Checked in a throwaway index,
    // which reads the repository and writes nothing to it.
    it('applies every patch to its base, where the history is there to check', async () => {
        const corpus = await loadCorpus(CASES_DIR);
        const present = await Promise.all(
            corpus.map(evalCase =>
                exec('git', ['cat-file', '-e', `${evalCase.base}^{tree}`]).then(
                    () => true,
                    () => false,
                ),
            ),
        );
        const dir = await mkdtemp(join(tmpdir(), 'review-eval-corpus-'));
        try {
            for (const [index, evalCase] of corpus.entries()) {
                if (!present[index]) continue;
                const env = { ...process.env, GIT_INDEX_FILE: join(dir, `${evalCase.id}.index`) };
                await exec('git', ['read-tree', evalCase.base], { env });
                await exec('git', ['apply', '--cached', '--check', evalCase.patchPath], { env });
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 120000);
});
