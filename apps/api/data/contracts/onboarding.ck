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

# One thing first run still needs, after deadair's onboarding requirements. There is one today,
# `account`: the operator account, which `POST /api/onboarding` creates. A list rather than a flag so
# a later first-run step joins it without a new endpoint, and a client that does not know a key can
# still name it (`title`) and say where to finish it.
contract OnboardingRequirement: {
    key: enum(account)
    title: string
    description: string
    # Whether first run can be finished without it.
    optional: boolean
}

# What first run still needs, empty once onboarding is done. The web app asks this to choose
# between the onboarding page and the sign-in page, and `wilson board init` to choose between
# creating the account and signing in; it says nothing else about the account.
contract OnboardingStatus: {
    requirements: array(OnboardingRequirement)
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
        name: Get onboarding requirements
        mcp: exclude # First-run setup, before there is anyone to act for
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
        mcp: exclude # First-run setup, before there is anyone to act for
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
