import type { RegisterDeviceRequest, UnregisterDeviceRequest } from './types/devices.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer } from './sdk-options.js';

/**
 * generated from [devices.ck](../../../apps/api/data/contracts/devices.ck)
 */
export class DevicesClient {
    constructor(private fetch: SdkFetch) {}

    /** @name Register a device */
    async registerDevice(body: RegisterDeviceRequest): Promise<void> {
        await this.fetch(`/api/devices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
    }

    /** @name Unregister a device */
    async unregisterDevice(body: UnregisterDeviceRequest): Promise<void> {
        await this.fetch(`/api/devices/unregister`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
    }
}
