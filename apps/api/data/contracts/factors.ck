options {
    services: {
        FactorsService: "#modules/authentication/factors.service.js"
    }
    security: {
        policy: wilson.step.up
    }
}

# The operator's second factors (PROJECT.md, Authentication: Factors): an authenticator app (TOTP)
# or a passkey. Once one is enrolled, signing in asks for it after the password, and a step-up needs
# it rather than the password. Passkeys work only in the web app: a passkey is bound to the origin it
# was made at, and the API holds that to `WEB_ORIGINS`.
#
# The floor is `wilson.step.up`: adding or removing a factor changes what it takes to sign in, so it
# needs a factor proved in the last five minutes, and once a strong factor is enrolled, that one.
# Otherwise anyone holding a signed-in session could enrol their own authenticator and lock the
# operator out. Listing lowers it to `wilson.view`.

contract SecondFactorMethod: enum(authenticator, passkey)

contract SecondFactorSummary: {
    id: string
    method: SecondFactorMethod
    label?: string
    createdAt: datetime
}

contract StartAuthenticatorRequest: {
    # What the authenticator app shows beside the code, after the issuer.
    label?: string(max=64)
}

# What to scan. `uri` is the `otpauth://` URI, `qrCode` the same as a PNG data URL, and `secret` the
# base32 seed for an app that cannot scan. Nothing is enrolled until a code from the app is checked
# (`verify`), within ten minutes.
contract AuthenticatorRegistration: {
    registrationId: string
    uri: string
    qrCode: string
    secret: string
}

contract VerifyAuthenticatorRequest: {
    registrationId: string
    code: string(min=6, max=10)
}

contract StartPasskeyRequest: {
    # A name to tell this passkey apart from others, such as the device it is on.
    label?: string(max=64)
}

# What to call `navigator.credentials.create` with. Nothing is enrolled until the browser's answer is
# checked (`passkey/verify`).
contract PasskeyRegistration: {
    registrationId: string
    options: PasskeyCreationOptions
}

contract VerifyPasskeyRequest: {
    registrationId: string
    credential: PasskeyAttestationCredential
}

operation /api/auth/factors: {
    get: {
        name: List second factors
        mcp: exclude # What it takes to sign in is never changed by an agent
        sdk: listSecondFactors
        service: FactorsService.list
        security: {
            policy: wilson.view
        }
        response: {
            200: {
                application/json: array(SecondFactorSummary)
            }
        }
    }
}

operation /api/auth/factors/authenticator: {
    post: {
        name: Start enrolling an authenticator app
        mcp: exclude # What it takes to sign in is never changed by an agent
        sdk: startAuthenticator
        service: FactorsService.startAuthenticator
        request: {
            application/json: StartAuthenticatorRequest
        }
        response: {
            200: {
                application/json: AuthenticatorRegistration
            }
            # Needs a recent factor: sign in again.
            403:
        }
    }
}

operation /api/auth/factors/authenticator/verify: {
    post: {
        name: Finish enrolling an authenticator app
        mcp: exclude # What it takes to sign in is never changed by an agent
        sdk: verifyAuthenticator
        service: FactorsService.verifyAuthenticator
        request: {
            application/json: VerifyAuthenticatorRequest
        }
        response: {
            201: {
                application/json: SecondFactorSummary
            }
            # The code is wrong, or the registration expired.
            401:
            403:
        }
    }
}

operation /api/auth/factors/passkey: {
    post: {
        name: Start enrolling a passkey
        mcp: exclude # What it takes to sign in is never changed by an agent
        sdk: startPasskey
        service: FactorsService.startPasskey
        request: {
            application/json: StartPasskeyRequest
        }
        response: {
            200: {
                application/json: PasskeyRegistration
            }
            # Not from the web app, at an address in `WEB_ORIGINS`.
            400:
            403:
        }
    }
}

operation /api/auth/factors/passkey/verify: {
    post: {
        name: Finish enrolling a passkey
        mcp: exclude # What it takes to sign in is never changed by an agent
        sdk: verifyPasskey
        service: FactorsService.verifyPasskey
        request: {
            application/json: VerifyPasskeyRequest
        }
        response: {
            201: {
                application/json: SecondFactorSummary
            }
            # The browser's answer does not check out, or the registration expired.
            400:
            401:
            403:
        }
    }
}

operation /api/auth/factors/{id}: {
    params: {
        id: string
    }
    delete: {
        name: Remove a second factor
        mcp: exclude # What it takes to sign in is never changed by an agent
        sdk: removeSecondFactor
        service: FactorsService.remove
        response: {
            204:
            403:
            404:
        }
    }
}
