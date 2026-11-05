options {
    services: {
        AppsService: "#modules/apps/apps.service.js"
    }
    security: {
        policy: wilson.step.up
    }
}

# Operator apps: one HTML file each, run by the web app in a sandboxed iframe with no network access
# and no credentials. An app reaches Wilson only by asking the web app, which answers only what the
# app's grants allow. Deployment-scoped like `hosts.ck`, not per project.
#
# The floor is `wilson.step.up`, because a grant hands out authority: only a session that proved a
# factor in the last five minutes may install, replace or remove an app, never a key. Reading lowers
# it to `wilson.view`. Every operation is out of an agent's reach (PROJECT.md decision 8).

# What an app may ask the web app for. All of it is read-only, and all of it is about the project the
# app was opened in.
contract AppGrant: enum(board.read, activity.read, stats.read)

# An app as a list shows it, without its HTML.
contract AppSummary: {
    slug: string
    name: string
    description: string
    grants: array(AppGrant)
    createdAt: datetime
    updatedAt: datetime
}

# An app and what it runs.
contract App: {
    slug: string
    name: string
    description: string
    grants: array(AppGrant)
    html: string
    createdAt: datetime
    updatedAt: datetime
}

contract InstallAppRequest: {
    name: string(min=1, max=100)
    # Unset means no description.
    description?: string(max=500)
    # The whole app, at most 512 KiB once encoded as UTF-8.
    html: string(min=1)
    # Replaces whatever grants the app had before.
    grants: array(AppGrant)
}

operation /api/apps: {
    get: {
        name: List apps
        mcp: exclude # Apps are the operator's, like the rest of the machinery
        sdk: listApps
        security: {
            policy: wilson.view
        }
        service: AppsService.list
        response: {
            200: {
                application/json: array(AppSummary)
            }
            401:
        }
    }
}

operation /api/apps/{slug}: {
    params: {
        slug: string
    }
    get: {
        name: Get an app
        mcp: exclude # Apps are the operator's, like the rest of the machinery
        sdk: getApp
        security: {
            policy: wilson.view
        }
        service: AppsService.get
        response: {
            200: {
                application/json: App
            }
            401:
            404:
        }
    }
    # Install an app under this slug, or replace the one already there. `createdAt` survives a replace.
    put: {
        name: Install an app
        mcp: exclude # Step-up: a grant hands out authority
        sdk: installApp
        service: AppsService.install
        request: {
            application/json: InstallAppRequest
        }
        response: {
            200: {
                application/json: App
            }
            # A malformed slug, a blank name, a grant outside the list, or HTML over 512 KiB.
            400:
            401:
            # Called with an API key, or a session whose factor is older than five minutes. Sign in.
            403:
            # A request body over the server's 1 MB limit for JSON, which HTML under 512 KiB reaches only
            # if nearly all of it needs escaping.
            422:
        }
    }
    delete: {
        name: Remove an app
        mcp: exclude # Step-up: removing an app rewrites what the operator approved
        sdk: removeApp
        service: AppsService.remove
        response: {
            204:
            401:
            403:
            404:
        }
    }
}
