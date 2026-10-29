import type { SdkOptions } from './sdk-options.js';
import { createSdkFetch } from './sdk-options.js';
import { BoardClient } from './board.client.js';
import { ChatClient } from './chat.client.js';
import { ContextClient } from './context.client.js';
import { HealthClient } from './health.client.js';
import { LearningsClient } from './learnings.client.js';
import { ProjectsClient } from './projects.client.js';
import { SettingsClient } from './settings.client.js';
import { StagesClient } from './stages.client.js';

export class WilsonSdk {
    readonly board: BoardClient;
    readonly chat: ChatClient;
    readonly context: ContextClient;
    readonly health: HealthClient;
    readonly learnings: LearningsClient;
    readonly projects: ProjectsClient;
    readonly settings: SettingsClient;
    readonly stages: StagesClient;

    constructor(options: SdkOptions) {
        const sdkFetch = options.fetch ?? createSdkFetch(options);
        this.board = new BoardClient(sdkFetch);
        this.chat = new ChatClient(sdkFetch);
        this.context = new ContextClient(sdkFetch);
        this.health = new HealthClient(sdkFetch);
        this.learnings = new LearningsClient(sdkFetch);
        this.projects = new ProjectsClient(sdkFetch);
        this.settings = new SettingsClient(sdkFetch);
        this.stages = new StagesClient(sdkFetch);
    }
}
