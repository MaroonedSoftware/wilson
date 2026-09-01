import type { SdkOptions } from './sdk-options.js';
import { createSdkFetch } from './sdk-options.js';
import { StagesClient } from './stages.client.js';
import { SettingsClient } from './settings.client.js';
import { ProjectsClient } from './projects.client.js';
import { HealthClient } from './health.client.js';
import { BoardClient } from './board.client.js';

export class WilsonSdk {
    readonly stages: StagesClient;
    readonly settings: SettingsClient;
    readonly projects: ProjectsClient;
    readonly health: HealthClient;
    readonly board: BoardClient;

    constructor(options: SdkOptions) {
        const sdkFetch = options.fetch ?? createSdkFetch(options);
        this.stages = new StagesClient(sdkFetch);
        this.settings = new SettingsClient(sdkFetch);
        this.projects = new ProjectsClient(sdkFetch);
        this.health = new HealthClient(sdkFetch);
        this.board = new BoardClient(sdkFetch);
    }
}
