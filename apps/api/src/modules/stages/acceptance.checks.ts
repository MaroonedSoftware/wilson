import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { z } from 'zod';
import { acceptanceCriteria, normalizeCriterionId, oneLine, type Card } from '#modules/board/card.js';
import { worktreeHost, WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { runConfiguredCommand } from './run.command.js';
import type { StageConfig } from './stage.config.js';
import type { StageVerifier, VerificationInput, VerificationOutcome } from './stage.verifier.js';
import { parseTestReport } from './test.report.js';

/** The section the runner writes once a card's acceptance checks are proven red, and every later stage reads. */
export const ACCEPTANCE_CHECKS_HEADING = '## Acceptance checks';

/**
 * Whether a report's file is the check's. A report names files from the runner's own cwd, which can be
 * the tree's real path rather than the one it was opened by (`/private/var` for `/var` on macOS), so
 * the relative form can carry a prefix the check's path does not.
 */
const sameFile = (reported: string, file: string): boolean => reported === file || reported.endsWith(`/${file}`);

/** A test file, by the names this repo's runners collect. Only these may be written before the code. */
export const isTestPath = (path: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

export const AcceptanceCheckSchema = z.object({
    criterion: z.string().describe('The acceptance criterion this test checks, by its ID, e.g. "AC2".'),
    file: z.string().describe('The test file, relative to the worktree.'),
    name: z.string().min(1).describe('Part of the test’s name, enough to tell it apart within its file.'),
});

export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

/**
 * What the acceptance step reports: the tests it wrote, each labelled with the criterion it checks,
 * and the criteria no test can settle (a manual look, a production-only effect), each with why.
 */
export const AcceptanceResultSchema = z.object({
    summary: z.string(),
    checks: z.array(AcceptanceCheckSchema),
    uncheckable: z
        .array(z.object({ criterion: z.string(), reason: z.string().min(1) }))
        .default([])
        .describe('Criteria no automated test can settle, each with why. Every other criterion needs at least one check.'),
    difficulty: z.string().optional().describe('Optional. One line on what slowed you down, if anything did.'),
});

export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

/** Whether the card already has its checks, which is what tells the lane its enter step has run. */
export const hasAcceptanceChecks = (card: Card): boolean => card.body.split('\n').some(line => line.trim() === ACCEPTANCE_CHECKS_HEADING);

/** The step a lane runs when a card enters it with no checks yet, if it has one. */
export const enterStep = (lane: StageConfig, card: Card): string | undefined =>
    lane.step || hasAcceptanceChecks(card) ? undefined : lane.steps?.find(step => step.on === 'enter')?.name;

/** Whether `stage` is a lane's enter step, the run that writes the checks rather than one held to them. */
export const isEnterStep = (stage: StageConfig): boolean =>
    Boolean(stage.step) && stage.steps?.some(step => step.name === stage.step && step.on === 'enter') === true;

/** The section, from the step's report. Written once, after the step passed, and never by an agent. */
export const withAcceptanceChecks = (body: string, result: AcceptanceResult): string => {
    const lines = [
        ACCEPTANCE_CHECKS_HEADING,
        '',
        'Written from the acceptance criteria before any code, and proven to fail on the code as it was. These files are locked: make the code pass them.',
        '',
        ...result.checks.map(check => `- \`${normalizeCriterionId(check.criterion)}\`: \`${check.file}\` > ${oneLine(check.name)}`),
        ...result.uncheckable.map(item => `- \`${normalizeCriterionId(item.criterion)}\`: not checkable by a test: ${oneLine(item.reason)}`),
    ];
    return `${body.trimEnd()}\n\n${lines.join('\n')}\n`;
};

/** The locked files the section names, read back from {@link withAcceptanceChecks}'s bullets. */
export const acceptanceCheckPaths = (body: string): string[] => {
    const lines = body.split('\n');
    const start = lines.findIndex(line => line.trim() === ACCEPTANCE_CHECKS_HEADING);
    if (start === -1) return [];
    const paths = new Set<string>();
    for (const line of lines.slice(start + 1)) {
        if (/^##\s+/.test(line)) break;
        const match = /^- `[^`]+`: `([^`]+)` > /.exec(line);
        if (match) paths.add(match[1]!);
    }
    return [...paths];
};

/**
 * The acceptance step's exit condition. Every acceptance criterion is accounted for, by at least one
 * labelled check or a reason no test can settle it. Only test files were written, and every check
 * names one of them. And every check fails on the code as it is: a test that passes before the change
 * cannot tell the change from no change, so it proves nothing.
 *
 * A check counts as failing when its test is among the report's failures, or when its whole file failed
 * to load, which is the ordinary state of a test importing a module the card has yet to write.
 */
@Injectable()
export class AcceptanceVerifier implements StageVerifier {
    constructor(private readonly worktrees: WorktreeManager) {}

    async verify({ worktree, stage, card, result }: VerificationInput): Promise<VerificationOutcome> {
        const failures: string[] = [];
        const written = (await this.worktrees.uncommittedPaths(worktree)).filter(path => path !== stage.testReportPath);

        const parsed = AcceptanceResultSchema.safeParse(result);
        if (!parsed.success) {
            return {
                passed: false,
                failures: [`the reported result does not match the acceptance schema: ${parsed.error.message}`],
                changedPaths: written,
            };
        }
        const { checks, uncheckable } = parsed.data;

        // Provenance: every ID is one the plan has, and every one the plan has is accounted for.
        let reportFault = false;
        const planIds = new Set(acceptanceCriteria(card).map(criterion => criterion.id));
        const covered = new Set<string>();
        for (const id of [...checks.map(check => check.criterion), ...uncheckable.map(item => item.criterion)]) {
            const normalized = normalizeCriterionId(id);
            if (!planIds.has(normalized)) {
                failures.push(`criterion "${id}" is not among the plan's acceptance criteria (${[...planIds].join(', ') || 'none'})`);
                reportFault = true;
            }
            covered.add(normalized);
        }
        for (const id of planIds) {
            if (!covered.has(id)) failures.push(`acceptance criterion ${id} has no check and no reason it cannot have one`);
        }

        const notTests = written.filter(path => !isTestPath(path));
        if (notTests.length > 0) failures.push(`only tests are written before the code, and this step also wrote: ${notTests.join(', ')}`);
        for (const check of checks) {
            if (!written.includes(check.file)) failures.push(`the check for ${check.criterion} names ${check.file}, which this step did not write`);
        }

        if (checks.length > 0 && failures.length === 0) failures.push(...(await this.provenRed(worktree, stage, checks)));

        return {
            passed: failures.length === 0,
            failures,
            changedPaths: written,
            ...(reportFault && failures.length > 0 ? { reportRejected: true } : {}),
        };
    }

    /** The checks that did not fail on the code as it is, each as a failure. */
    private async provenRed(worktree: VerificationInput['worktree'], stage: StageConfig, checks: AcceptanceCheck[]): Promise<string[]> {
        if (!stage.testCommand || !stage.testReportPath) {
            return ['the acceptance step needs testCommand and testReportPath, to prove its checks fail before the code'];
        }
        const host = worktreeHost(worktree);
        const reportPath = join(worktree.path, stage.testReportPath);
        await host.removeTree(reportPath).catch(() => undefined);
        // Expected to exit non-zero: the checks are meant to fail.
        await runConfiguredCommand(worktree.path, stage.testCommand, stage.testTimeoutMs, undefined, host);
        let failing;
        try {
            failing = parseTestReport(await host.readFile(reportPath), worktree.path).failing ?? [];
        } catch (err) {
            return [`could not read the test report at ${stage.testReportPath}: ${(err as Error).message}`];
        } finally {
            await host.removeTree(reportPath).catch(() => undefined);
        }
        return checks
            .filter(check => !failing.some(test => sameFile(test.file, check.file) && (test.name === undefined || test.name.includes(check.name))))
            .map(
                check =>
                    `the check for ${check.criterion} (${check.file} > ${check.name}) did not fail on the code as it is, so it cannot tell the change from no change`,
            );
    }
}
