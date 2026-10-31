package com.maroonedsoftware.wilson.auth

import com.maroonedsoftware.wilson.net.Patience
import com.maroonedsoftware.wilson.net.ServerUrl
import com.maroonedsoftware.wilson.sdk.WilsonSdk
import com.maroonedsoftware.wilson.sdk.models.MfaFactor
import com.maroonedsoftware.wilson.sdk.models.MfaFactorMethod
import com.maroonedsoftware.wilson.sdk.models.TokenRequest
import com.maroonedsoftware.wilson.sdk.models.TokenRequestGrantType
import com.maroonedsoftware.wilson.sdk.models.TokenResponse
import com.maroonedsoftware.wilson.sdk.models.TokenResponseResult
import com.maroonedsoftware.wilson.sdk.runtime.SdkError
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Nothing is signed in, so the call that needed a session was never made. */
class NotSignedInException : Exception("Not signed in")

/** A refresh got an answer that was not the API's verdict on the token, so the session stands. */
class SessionUnavailableException(cause: SdkError) : IOException("The server did not answer the refresh (${cause.status})", cause)

/** What came of offering a password, or a code against a pending sign-in. */
sealed interface SignInResult {
    data object Ok : SignInResult

    data object BadCredentials : SignInResult

    data object TooManyAttempts : SignInResult

    /** A correct password, and an authenticator code is due. */
    data class CodeNeeded(val challengeId: String, val factors: List<MfaFactor>) : SignInResult

    /** A correct password, on an account whose only second factors are passkeys, which this app cannot answer. */
    data object PasskeyOnly : SignInResult

    data class Failed(val message: String?) : SignInResult
}

/** Whether this is the API refusing the token itself, rather than something in front of it answering. */
fun refusesRefresh(status: Int, wwwAuthenticate: String?): Boolean =
    status == 401 && wwwAuthenticate != null && REFRESH_REFUSALS.containsMatchIn(wwwAuthenticate)

private val REFRESH_REFUSALS = Regex("""error="(invalid_request|invalid_token|invalid_grant)"""")

/**
 * The signed-in half of the app.
 *
 * **A refresh is single-flight.** Refresh tokens are single-use, and presenting a spent one revokes
 * the whole family, so two screens meeting the same 401 is the ordinary case rather than a race to
 * ignore. Refreshing takes a lock, and the first thing inside it is to check the token it set out to
 * replace is still current. If not, somebody else refreshed and their answer is the good one.
 *
 * **A session ends only when the API refuses the refresh** ([refusesRefresh]). A network failure, a
 * 5xx, the rate limiter's 429 or a proxy's own answer says nothing about the token, so each leaves the
 * session on disk.
 */
class SessionManager(
    private val store: SessionStorage,
    private val sdkFor: (ServerUrl, Patience, suspend () -> Map<String, String>) -> WilsonSdk,
) {
    private val refreshLock = Mutex()

    val session: Flow<StoredSession?> = store.stored

    suspend fun signIn(server: ServerUrl, email: String, password: String): SignInResult =
        exchange(server, email, TokenRequest(grantType = TokenRequestGrantType.PASSWORD, email = email, password = password))

    suspend fun finishSignIn(server: ServerUrl, email: String, challengeId: String, factorId: String?, code: String): SignInResult =
        exchange(
            server,
            email,
            TokenRequest(grantType = TokenRequestGrantType.AUTHENTICATOR, challengeId = challengeId, factorId = factorId, code = code),
        )

    private suspend fun exchange(server: ServerUrl, email: String, request: TokenRequest): SignInResult {
        val answer =
            try {
                anonymous(server).auth.requestToken(request)
            } catch (error: SdkError) {
                return when (error.status) {
                    400, 401 -> SignInResult.BadCredentials
                    429 -> SignInResult.TooManyAttempts
                    else -> SignInResult.Failed(error.message)
                }
            } catch (error: Exception) {
                return SignInResult.Failed(error.message)
            }
        return accept(server, email, answer)
    }

    private suspend fun accept(server: ServerUrl, email: String, answer: TokenResponse): SignInResult {
        if (answer.result == TokenResponseResult.MFA_REQUIRED) {
            val challengeId = answer.challengeId ?: return SignInResult.Failed("No challenge in the answer")
            val codes = answer.factors.orEmpty().filter { it.method == MfaFactorMethod.AUTHENTICATOR }
            return if (codes.isEmpty()) SignInResult.PasskeyOnly else SignInResult.CodeNeeded(challengeId, codes)
        }
        val access = answer.accessToken
        // A token with nothing to renew it would end the session silently, so it is not kept.
        val refresh = answer.refreshToken
        if (access == null || refresh == null) return SignInResult.Failed("No session in the answer")
        store.save(StoredSession(server.origin, email, access, refresh))
        return SignInResult.Ok
    }

    /**
     * Runs [block] with the session's bearer and, when given, a project scope. A 401 refreshes once
     * and tries again, and the retry reads the new token because the headers are read per request.
     */
    suspend fun <T> call(project: String? = null, patience: Patience = Patience.SHORT, block: suspend (WilsonSdk) -> T): T {
        val current = store.stored.first() ?: throw NotSignedInException()
        try {
            return block(authorized(current, project, patience))
        } catch (error: SdkError) {
            if (error.status != 401) throw error
        }
        val fresh = refreshed(current.accessToken) ?: throw NotSignedInException()
        return block(authorized(fresh, project, patience))
    }

    /** The bearer and project headers for a raw request, such as an event stream. */
    fun headersFor(session: StoredSession, project: String?): Map<String, String> = buildMap {
        put("Authorization", "Bearer ${session.accessToken}")
        if (project != null) put("X-Wilson-Project", project)
    }

    private fun authorized(session: StoredSession, project: String?, patience: Patience) =
        sdkFor(ServerUrl(session.origin), patience) { headersFor(session, project) }

    private fun anonymous(server: ServerUrl) = sdkFor(server, Patience.SHORT) { emptyMap() }

    /** A session newer than [staleAccessToken], or null when the API refused it and it is gone. */
    suspend fun refreshed(staleAccessToken: String): StoredSession? =
        refreshLock.withLock {
            val current = store.stored.first() ?: return@withLock null
            if (current.accessToken != staleAccessToken) return@withLock current

            val answer =
                try {
                    anonymous(ServerUrl(current.origin)).auth.requestToken(
                        TokenRequest(grantType = TokenRequestGrantType.REFRESH_TOKEN, refreshToken = current.refreshToken),
                    )
                } catch (error: SdkError) {
                    if (!refusesRefresh(error.status, error.response.headers["WWW-Authenticate"])) throw SessionUnavailableException(error)
                    store.clear()
                    return@withLock null
                }

            val access = answer.accessToken
            if (answer.result != TokenResponseResult.TOKEN || access == null) {
                store.clear()
                return@withLock null
            }
            // Keeping the old refresh token when none came back costs a 401; dropping a good one costs the session.
            current.copy(accessToken = access, refreshToken = answer.refreshToken ?: current.refreshToken).also { store.save(it) }
        }

    /** Best effort at the server, certain on the phone: a dead network never keeps anybody signed in. */
    suspend fun signOut() {
        val current = store.stored.first()
        if (current != null) runCatching { authorized(current, null, Patience.SHORT).auth.logout() }
        store.clear()
    }
}
