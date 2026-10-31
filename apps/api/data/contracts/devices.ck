options {
    services: {
        DevicesService: "#modules/notify/devices.service.js"
    }
    security: {
        policy: wilson.manage
    }
}

# The phones that receive push notifications (PROJECT.md, Notification). Every write here needs
# `wilson.manage`, as every write does, and a device only ever learns that a card by id wants attention.
# The token travels in a body, never a path, so it stays out of access logs, which is why
# removing one is a POST.

contract RegisterDeviceRequest: {
    # FCM's registration token for this install of the app.
    token: string(min=1, max=4096)
    # What to call the phone, such as its model.
    label?: string(max=100)
}

contract UnregisterDeviceRequest: {
    token: string(min=1, max=4096)
}

operation /api/devices: {
    post: {
        name: Register a device
        mcp: exclude # A device token is for the phone that holds it, not an agent
        sdk: registerDevice
        service: DevicesService.register
        request: {
            application/json: RegisterDeviceRequest
        }
        response: {
            204:
        }
    }
}

operation /api/devices/unregister: {
    post: {
        name: Unregister a device
        mcp: exclude # A device token is for the phone that holds it, not an agent
        sdk: unregisterDevice
        service: DevicesService.unregister
        request: {
            application/json: UnregisterDeviceRequest
        }
        response: {
            # Gone, or was never here. Either way this token gets nothing more.
            204:
        }
    }
}
