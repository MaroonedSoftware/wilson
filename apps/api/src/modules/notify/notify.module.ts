import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { DeviceRepository } from './device.repository.js';
import { DevicesService } from './devices.service.js';

/** The phones push notifications go to (`devices.ck`). `Notifier` itself is not DI-managed; see its own doc. */
export const NotifyModule: ServerKitModule = {
    name: 'Notify',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(DeviceRepository).useClass(DeviceRepository).asSingleton();
        registry.register(DevicesService).useClass(DevicesService).asTransient();
    },
};
