import type { SettingDefinition } from '#modules/settings/setting.definition.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';

/** A `SettingsStore` where every setting resolves to its coded default, for a job built by hand. */
export const defaultSettings = { get: async <T>(definition: SettingDefinition<T>) => definition.defaultValue } as unknown as SettingsStore;
