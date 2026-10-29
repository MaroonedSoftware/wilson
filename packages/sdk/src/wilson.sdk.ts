import type { SdkOptions } from './sdk-options.js';
import { createSdkFetch } from './sdk-options.js';
import { StagesClient } from './stages.client.js';
import { SettingsClient } from './settings.client.js';
import { ProjectsClient } from './projects.client.js';
import { OnboardingClient } from './onboarding.client.js';
import { LearningsClient } from './learnings.client.js';
import { HealthClient } from './health.client.js';
import { ContextClient } from './context.client.js';
import { BoardClient } from './board.client.js';

export class WilsonSdk {
    readonly stages: StagesClient;
    readonly settings: SettingsClient;
    readonly projects: ProjectsClient;
    readonly onboarding: OnboardingClient;
    readonly learnings: LearningsClient;
    readonly health: HealthClient;
    readonly context: ContextClient;
    readonly board: BoardClient;

    constructor(options: SdkOptions) {
        const sdkFetch = options.fetch ?? createSdkFetch(options);
        this.stages = new StagesClient(sdkFetch);
        this.settings = new SettingsClient(sdkFetch);
        this.projects = new ProjectsClient(sdkFetch);
        this.onboarding = new OnboardingClient(sdkFetch);
        this.learnings = new LearningsClient(sdkFetch);
        this.health = new HealthClient(sdkFetch);
        this.context = new ContextClient(sdkFetch);
        this.board = new BoardClient(sdkFetch);
    }
}
