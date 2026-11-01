/**
 * generated from [RegisterDeviceRequest](../../../../apps/api/data/contracts/devices.ck)
 */
export interface RegisterDeviceRequest {
    /** FCM's registration token for this install of the app. */
    token: string;
    /** What to call the phone, such as its model. */
    label?: string;
}

/**
 * generated from [UnregisterDeviceRequest](../../../../apps/api/data/contracts/devices.ck)
 */
export interface UnregisterDeviceRequest {
    token: string;
}
