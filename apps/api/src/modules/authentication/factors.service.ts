import { Injectable } from 'injectkit';
import { AuthenticatorFactorService, FidoFactorService, type PublicKeyCredentialWithAttestation } from '@maroonedsoftware/authentication';
import { httpError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import type {
    AuthenticatorRegistration,
    PasskeyRegistration,
    SecondFactorSummary,
    StartAuthenticatorRequest,
    StartPasskeyRequest,
    VerifyAuthenticatorRequest,
    VerifyPasskeyRequest,
} from '../../generated/factors.js';
import { AccountFactors, type SecondFactor } from './account.factors.js';
import { AccountRepository } from './account.repository.js';
import { RELYING_PARTY_NAME, relyingPartyFor } from './passkey.relying.party.js';
import { requireSession } from './request.session.js';
import { WebOrigins } from './web.origins.js';

const toSummary = (factor: SecondFactor): SecondFactorSummary => ({
    id: factor.methodId,
    method: factor.method === 'fido' ? 'passkey' : 'authenticator',
    ...(factor.label === undefined ? {} : { label: factor.label }),
    createdAt: factor.createdAt,
});

/**
 * `/api/auth/factors`: enrolling and removing the operator's second factors. The route gate
 * (`wilson.step.up`, `factors.ck`) has already required a recently proved factor; this only does the
 * enrolment, through the library's `AuthenticatorFactorService` (which encrypts the seed, checks the
 * first code, and limits wrong codes) and `FidoFactorService` (which checks the browser's
 * attestation against the challenge it issued, for the relying party `relyingPartyFor` allows).
 *
 * Takes `ServerKitContext`, so the container wiring test exempts it.
 */
@Injectable()
export class FactorsService {
    constructor(
        private readonly context: ServerKitContext,
        private readonly authenticators: AuthenticatorFactorService,
        private readonly passkeys: FidoFactorService,
        private readonly factors: AccountFactors,
        private readonly accounts: AccountRepository,
        private readonly origins: WebOrigins,
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

    async startPasskey(request: StartPasskeyRequest): Promise<PasskeyRegistration> {
        const accountId = this.accountId();
        const party = relyingPartyFor(this.context, this.origins);
        const account = await this.accounts.get(accountId);
        if (!account) throw httpError(404).withDetails({ reason: 'the account is gone' });
        const registration = await this.passkeys.registerFidoFactor(accountId, {
            label: request.label?.trim() || undefined,
            rpId: party.rpId,
            rpOrigin: party.rpOrigin,
            rpName: RELYING_PARTY_NAME,
            userName: account.email,
            userDisplayName: account.email,
        });
        const { rp, user, challenge, pubKeyCredParams, timeout, attestation } = registration.attestation;
        return {
            registrationId: registration.registrationId,
            options: {
                rp: { id: rp.id, name: rp.name },
                user,
                challenge,
                pubKeyCredParams,
                ...(timeout === undefined ? {} : { timeout }),
                attestation: String(attestation),
            },
        };
    }

    async verifyPasskey(request: VerifyPasskeyRequest): Promise<SecondFactorSummary> {
        const accountId = this.accountId();
        const factor = await this.passkeys.createFidoFactorFromRegistration(
            accountId,
            request.registrationId,
            request.credential as PublicKeyCredentialWithAttestation,
        );
        const enrolled = (await this.factors.list(accountId)).find(candidate => candidate.methodId === factor.id);
        if (!enrolled) throw httpError(500).withInternalDetails({ message: `passkey ${factor.id} enrolled but not listed` });
        return toSummary(enrolled);
    }

    async remove(id: string): Promise<void> {
        const accountId = this.accountId();
        const factor = (await this.factors.list(accountId)).find(candidate => candidate.methodId === id);
        if (!factor) throw httpError(404).withDetails({ reason: `no second factor ${id}` });
        if (factor.method === 'fido') await this.passkeys.deleteFactor(accountId, id);
        else await this.authenticators.deleteFactor(accountId, id);
    }
}
