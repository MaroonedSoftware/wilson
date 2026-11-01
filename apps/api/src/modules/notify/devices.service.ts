import { Injectable } from 'injectkit';
import { ServerKitContext } from '@maroonedsoftware/koa';
import { requireSession } from '#modules/authentication/request.session.js';
import type { RegisterDeviceRequest, UnregisterDeviceRequest } from '../../generated/devices.js';
import { DeviceRepository } from './device.repository.js';

/**
 * `/api/devices`: a phone asking for push notifications, or to stop.
 *
 * Takes `ServerKitContext`, so the container wiring test exempts it, as it does `ApiKeysService`.
 */
@Injectable()
export class DevicesService {
    constructor(
        private readonly context: ServerKitContext,
        private readonly devices: DeviceRepository,
    ) {}

    async register(request: RegisterDeviceRequest): Promise<void> {
        await this.devices.register({
            token: request.token,
            accountId: requireSession(this.context).subject,
            ...(request.label ? { label: request.label } : {}),
        });
    }

    async unregister(request: UnregisterDeviceRequest): Promise<void> {
        await this.devices.remove(request.token);
    }
}
