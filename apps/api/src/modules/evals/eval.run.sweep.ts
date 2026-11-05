import { Injectable } from 'injectkit';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { EvalRunRepository } from './eval.run.repository.js';

/**
 * At boot, before the queue is drained: a run still marked `running` belonged to a process that has
 * gone, so it is abandoned, left out of the counts, and its batch is sent on. A batch may end up
 * carried by two jobs this way, which is harmless: each takes the next run only if it can claim it.
 */
@Injectable()
export class EvalRunSweep {
    constructor(
        private readonly runs: EvalRunRepository,
        private readonly broker: JobBroker,
        private readonly logger: Logger,
    ) {}

    async run(): Promise<void> {
        try {
            for (const { id, project } of await this.runs.abandonStranded()) {
                await this.broker.send('eval.run', { batchId: id, project });
            }
        } catch (err) {
            this.logger.warn(`could not sweep eval runs: ${(err as Error).message}`);
        }
    }
}
