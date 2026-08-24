import type { SdkOptions } from './sdk-options.js';
import { createSdkFetch } from './sdk-options.js';
import { HealthClient } from './health.client.js';
import { BoardClient } from './board.client.js';

export class WilsonSdk {
    readonly health: HealthClient;
    readonly board: BoardClient;

    constructor(options: SdkOptions) {
        const sdkFetch = options.fetch ?? createSdkFetch(options);
        this.health = new HealthClient(sdkFetch);
        this.board = new BoardClient(sdkFetch);
    }
}
