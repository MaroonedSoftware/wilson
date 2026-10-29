import { Injectable } from 'injectkit';
import { AuthenticatorFactorService } from '@maroonedsoftware/authentication';
import { httpError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import type {
    AuthenticatorRegistration,
    SecondFactorSummary,
    StartAuthenticatorRequest,
    VerifyAuthenticatorRequest,
} from '../../generated/factors.js';
import { AccountFactors, type SecondFactor } from './account.factors.js';
import { requireSession } from './request.session.js';

const toSummary = (factor: SecondFactor): SecondFactorSummary => ({
    id: factor.methodId,
    method: 'authenticator',
    ...(factor.label === undefined ? {} : { label: factor.label }),
    createdAt: factor.createdAt,
});

/**
 * `/api/auth/factors`: enrolling and removing the operator's second factors. The route gate
 * (`wilson.step.up`, `factors.ck`) has already required a recently proved factor; this only does the
 * enrolment, through the library's `AuthenticatorFactorService`, which encrypts the seed, checks the
 * first code, and limits wrong codes.
 *
 * Takes `ServerKitContext`, so the container wiring test exempts it.
 */
@Injectable()
export class FactorsService {
    constructor(
        private readonly context: ServerKitContext,
        private readonly authenticators: AuthenticatorFactorService,
        private readonly factors: AccountFactors,
    ) {}

    private accountId(): string {
        return requireSession(this.context).subject;
    }

    async list(): Promise<SecondFactorSummary[]> {
        return (await this.factors.list(this.accountId())).map(toSummary);
    }

    async startAuthenticator(request: StartAuthenticatorRequest): Promise<AuthenticatorRegistration> {
        const registration = await this.authenticators.registerAuthenticatorFactor(this.accountId(), request.label?.trim() || undefined);
        return { registrationId: registration.registrationId, uri: registration.uri, qrCode: registration.qrCode, secret: registration.secret };
    }

    async verifyAuthenticator(request: VerifyAuthenticatorRequest): Promise<SecondFactorSummary> {
        const accountId = this.accountId();
        const factor = await this.authenticators.createAuthenticatorFactorFromRegistration(accountId, request.registrationId, request.code.trim());
        const enrolled = (await this.factors.list(accountId)).find(candidate => candidate.methodId === factor.id);
        if (!enrolled) throw httpError(500).withInternalDetails({ message: `authenticator ${factor.id} enrolled but not listed` });
        return toSummary(enrolled);
    }

    async remove(id: string): Promise<void> {
        const accountId = this.accountId();
        if (!(await this.factors.list(accountId)).some(factor => factor.methodId === id)) {
            throw httpError(404).withDetails({ reason: `no second factor ${id}` });
        }
        await this.authenticators.deleteFactor(accountId, id);
    }
}
