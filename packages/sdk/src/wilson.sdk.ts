import type { SdkOptions } from './sdk-options.js';
import { createSdkFetch } from './sdk-options.js';
import { ApiKeysClient } from './api.keys.client.js';
import { AppsClient } from './apps.client.js';
import { AuthClient } from './auth.client.js';
import { BoardClient } from './board.client.js';
import { ChatClient } from './chat.client.js';
import { CodeClient } from './code.client.js';
import { ContextClient } from './context.client.js';
import { DevicesClient } from './devices.client.js';
import { EngineTokensClient } from './engine.tokens.client.js';
import { EvalsClient } from './evals.client.js';
import { FactorsClient } from './factors.client.js';
import { HealthClient } from './health.client.js';
import { HostsClient } from './hosts.client.js';
import { LearningsClient } from './learnings.client.js';
import { OnboardingClient } from './onboarding.client.js';
import { ProjectsClient } from './projects.client.js';
import { ReviewClient } from './review.client.js';
import { RulesClient } from './rules.client.js';
import { SettingsClient } from './settings.client.js';
import { StagesClient } from './stages.client.js';

export class WilsonSdk {
    readonly apiKeys: ApiKeysClient;
    readonly apps: AppsClient;
    readonly auth: AuthClient;
    readonly board: BoardClient;
    readonly chat: ChatClient;
    readonly code: CodeClient;
    readonly context: ContextClient;
    readonly devices: DevicesClient;
    readonly engineTokens: EngineTokensClient;
    readonly evals: EvalsClient;
    readonly factors: FactorsClient;
    readonly health: HealthClient;
    readonly hosts: HostsClient;
    readonly learnings: LearningsClient;
    readonly onboarding: OnboardingClient;
    readonly projects: ProjectsClient;
    readonly review: ReviewClient;
    readonly rules: RulesClient;
    readonly settings: SettingsClient;
    readonly stages: StagesClient;

    constructor(options: SdkOptions) {
        const sdkFetch = options.fetch ?? createSdkFetch(options);
        this.apiKeys = new ApiKeysClient(sdkFetch);
        this.apps = new AppsClient(sdkFetch);
        this.auth = new AuthClient(sdkFetch);
        this.board = new BoardClient(sdkFetch);
        this.chat = new ChatClient(sdkFetch);
        this.code = new CodeClient(sdkFetch);
        this.context = new ContextClient(sdkFetch);
        this.devices = new DevicesClient(sdkFetch);
        this.engineTokens = new EngineTokensClient(sdkFetch);
        this.evals = new EvalsClient(sdkFetch);
        this.factors = new FactorsClient(sdkFetch);
        this.health = new HealthClient(sdkFetch);
        this.hosts = new HostsClient(sdkFetch);
        this.learnings = new LearningsClient(sdkFetch);
        this.onboarding = new OnboardingClient(sdkFetch);
        this.projects = new ProjectsClient(sdkFetch);
        this.review = new ReviewClient(sdkFetch);
        this.rules = new RulesClient(sdkFetch);
        this.settings = new SettingsClient(sdkFetch);
        this.stages = new StagesClient(sdkFetch);
    }
}
