options {
    services: {
        HealthService: "#modules/health/health.service.js"
    }
    security: none
}

# What the server says about itself. `head` is the commit captured at boot, not the repo's current
# HEAD: this project lost three runs to a daemon quietly serving code from before a fix, and a field
# read per request would report the new commit and make exactly that daemon look current.
contract Health: {
    ok: boolean
    project: string
    head: string
}

operation /api/health: {
    get: {
        name: Health
        sdk: getHealth
        service: HealthService.get
        response: {
            200: { application/json: Health }
        }
    }
}
