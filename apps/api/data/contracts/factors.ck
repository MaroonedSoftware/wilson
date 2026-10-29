options {
    services: {
        FactorsService: "#modules/authentication/factors.service.js"
    }
    security: {
        policy: wilson.step.up
    }
}

# The operator's second factors (PROJECT.md, Authentication: Factors). Today an authenticator app
# (TOTP); once one is enrolled, signing in asks for its code after the password, and a step-up
# needs it rather than the password.
#
# The floor is `wilson.step.up`: adding or removing a factor changes what it takes to sign in, so it
# needs a factor proved in the last five minutes, and once a strong factor is enrolled, that one.
# Otherwise anyone holding a signed-in session could enrol their own authenticator and lock the
# operator out. Listing lowers it to `wilson.view`.

contract SecondFactorMethod: enum(authenticator)

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

operation /api/auth/factors: {
    get: {
        name: List second factors
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

operation /api/auth/factors/{id}: {
    params: {
        id: string
    }
    delete: {
        name: Remove a second factor
        sdk: removeSecondFactor
        service: FactorsService.remove
        response: {
            204:
            403:
            404:
        }
    }
}
