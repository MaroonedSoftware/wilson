options {
    services: {
        OnboardingService: "#modules/authentication/onboarding.service.js"
    }
    security: none
}

# First-run onboarding (PROJECT.md, Authentication): creating the one operator account.
#
# `security: none`, one of the few routes without a gate (PROJECT.md decision 10): onboarding runs
# before any account exists, so there is nobody to authenticate. What refuses a
# second account is the database, not a policy; see `OnboardingService`.

# Whether onboarding has happened. The web app asks this to choose between the onboarding page and
# the sign-in page; it says nothing else about the account.
contract OnboardingStatus: {
    accountExists: boolean
}

# The operator account. A username rather than an email address, so signing in needs no mail setup.
# `password` is checked for strength (zxcvbn, through the authentication library's password policy)
# beyond the length limits here.
contract CreateAccountRequest: {
    username: string(min=1, max=64)
    password: string(min=8, max=256)
}

operation /api/onboarding: {
    get: {
        name: Get onboarding status
        sdk: getOnboardingStatus
        service: OnboardingService.status
        response: {
            200: {
                application/json: OnboardingStatus
            }
        }
    }
    post: {
        name: Create the operator account
        sdk: createAccount
        service: OnboardingService.createAccount
        request: {
            application/json: CreateAccountRequest
        }
        response: {
            201: {
                application/json: OnboardingStatus
            }
            # A blank username, or a password too weak for the password policy.
            400:
            # An account already exists. Sign in instead.
            409:
        }
    }
}
