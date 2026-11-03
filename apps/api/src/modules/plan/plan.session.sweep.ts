import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { PlanService } from './plan.service.js';

/**
 * Closes the planning sessions of cards that have left planning, across every project, once as the
 * daemon starts. Nothing can be running in one then, and a worktree costs only a few megabytes until
 * the next restart. Never stops a start: a project that fails is logged and left for the next one.
 */
@Injectable()
export class PlanSessionSweep {
    constructor(
        private readonly plans: PlanService,
        private readonly projects: ProjectRepository,
        private readonly boardConfig: BoardConfig,
        private readonly logger: Logger,
    ) {}

    async run(): Promise<void> {
        try {
            for (const row of await this.projects.list()) {
                this.boardConfig.register(row);
                try {
                    const closed = await runAsProject(row.name, () => this.plans.closeFinished());
                    if (closed.length > 0) this.logger.info(`closed the planning sessions of ${row.name}'s ${closed.join(', ')}`);
                } catch (error) {
                    this.logger.error(error);
                }
            }
        } catch (error) {
            this.logger.error(error);
        }
    }
}
