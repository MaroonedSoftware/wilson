import { z } from 'zod';

/**
 * generated from [RegisterDeviceRequest](../../data/contracts/devices.ck)
 */
export const RegisterDeviceRequest = z.strictObject({
    token: z.string().min(1).max(4096).describe("FCM's registration token for this install of the app."),
    label: z.string().max(100).optional().describe('What to call the phone, such as its model.'),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

/**
 * generated from [UnregisterDeviceRequest](../../data/contracts/devices.ck)
 */
export const UnregisterDeviceRequest = z.strictObject({
    token: z.string().min(1).max(4096),
});
export type UnregisterDeviceRequest = z.infer<typeof UnregisterDeviceRequest>;
