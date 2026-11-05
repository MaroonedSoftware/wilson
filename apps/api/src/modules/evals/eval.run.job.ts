import { Injectable } from 'injectkit';
import { Duration } from 'luxon';
import { Job, JobBroker, type JobQueuePolicy, type JobWorkerPolicy } from '@maroonedsoftware/jobbroker';
import { runAsProject } from '#modules/board/project.context.js';
import { EvalRunner } from './eval.runner.js';

export interface EvalRunPayload {
    batchId: string;
    project: string;
}

/** How long a batch waits before asking a busy host or a draining server again. */
export const EVAL_WAIT = Duration.fromObject({ minutes: 1 });

/** No retries: a run that failed to finish is recorded as that, and is not worth a second spend. */
export const EVAL_RUN_POLICY: JobQueuePolicy = {
    retryLimit: 0,
    expiresIn: Duration.fromObject({ hours: 3 }),
};

/** One at a time across every batch, so evals take one host slot however many are queued. */
export const EVAL_RUN_WORKER: JobWorkerPolicy = { concurrency: 1 };

/**
 * Carries a batch one run at a time: each job runs one and sends the next. A long batch therefore
 * never holds a job open, and a restart only costs the run in progress (`EvalRunSweep`).
 */
@Injectable()
export class EvalRunJob extends Job<EvalRunPayload> {
    constructor(
        private readonly runner: EvalRunner,
        private readonly broker: JobBroker,
    ) {
        super();
    }

    async run({ batchId, project }: EvalRunPayload): Promise<void> {
        const step = await runAsProject(project, () => this.runner.step(batchId));
        if (step.kind === 'next') await this.broker.send('eval.run', { batchId, project });
        if (step.kind === 'wait') await this.broker.send('eval.run', { batchId, project }, { startAfter: EVAL_WAIT });
    }
}
