import type { CommandModule } from '@maroonedsoftware/johnny5';
import { withApi } from '../../api-client.js';

interface CheckOpts {
    base?: string;
}

/**
 * Judge the project's rules against a branch's diff from its merge base, as a review would, with
 * nothing on the board moving. Each matching rule not already answered for this code is a model call.
 * Exits 1 when a blocker rule fails, the one case a review would send back.
 */
const command: CommandModule<CheckOpts> = {
    description: "Judge the project's rules against a branch",
    args: [{ name: 'branch', description: 'The branch to check', required: true }],
    options: [
        { flags: '--base <ref>', description: "What it forked from. Defaults to what the project's code root has checked out", type: 'string' },
    ],
    run: withApi<CheckOpts>(async (opts, ctx, args, api) => {
        const branch = String(args[0]);
        const report = await api.rules.checkRules({ branch, ...(opts.base ? { base: opts.base } : {}) });
        if (report.verdicts.length === 0) {
            ctx.logger.info(`no rule matches what ${branch} changed since ${report.mergeBase.slice(0, 8)}`);
            return 0;
        }

        for (const verdict of report.verdicts) {
            const cited = verdict.file ? `  ${verdict.file}${verdict.line ? `:${verdict.line}` : ''}` : '';
            const reused = verdict.reused ? '  (from an earlier run)' : '';
            process.stdout.write(`${verdict.verdict.padEnd(11)}  ${verdict.rule}${cited}${reused}\n    ${verdict.evidence}\n`);
        }
        const { inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 } = report.usage ?? {};
        process.stdout.write(
            `\n${report.verdicts.length} checked since ${report.mergeBase.slice(0, 8)}: ${inputTokens + cachedInputTokens} input and ${outputTokens} output tokens\n`,
        );

        return report.verdicts.some(verdict => verdict.verdict === 'fail' && verdict.severity === 'blocker') ? 1 : 0;
    }),
};

export default command;
