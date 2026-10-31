package com.maroonedsoftware.wilson.auth

import com.maroonedsoftware.wilson.net.ServerUrl
import com.maroonedsoftware.wilson.sdk.WilsonSdk
import com.maroonedsoftware.wilson.sdk.runtime.SdkConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private class FakeStorage(session: StoredSession? = null) : SessionStorage {
    override val stored = MutableStateFlow(session)

    override suspend fun save(session: StoredSession) {
        stored.value = session
    }

    override suspend fun clear() {
        stored.value = null
    }
}

private val SERVER = ServerUrl("https://wilson.example.com")
private val SIGNED_IN = StoredSession(SERVER.origin, "op@example.com", "old-access", "old-refresh")
private val JSON = headersOf(HttpHeaders.ContentType, "application/json")
private const val ROTATED = """{"result":"token","accessToken":"new-access","refreshToken":"new-refresh","expiresIn":3600,"tokenType":"Bearer"}"""
private const val SESSION = """{"accountId":"a","email":"op@example.com","issuedAt":"2026-10-31T00:00:00Z","expiresAt":"2026-11-01T00:00:00Z"}"""

class SessionManagerTest {
    private fun managerOver(storage: SessionStorage, handle: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) =
        SessionManager(storage) { server, _, headers ->
            WilsonSdk(SdkConfig(baseUrl = server.origin, headers = headers, httpClient = HttpClient(MockEngine { handle(it) })))
        }

    private fun HttpRequestData.bodyText() = (body as? TextContent)?.text.orEmpty()

    private fun MockRequestHandleScope.refused() =
        respond("", HttpStatusCode.Unauthorized, headersOf(HttpHeaders.WWWAuthenticate, """Bearer error="invalid_grant""""))

    @Test
    fun aPasswordOnlyAccountIsSignedIn() = runTest {
        val storage = FakeStorage()
        val manager = managerOver(storage) { respond(ROTATED, HttpStatusCode.OK, JSON) }

        assertEquals(SignInResult.Ok, manager.signIn(SERVER, "op@example.com", "hunter2"))
        assertEquals("new-refresh", storage.stored.value?.refreshToken)
    }

    @Test
    fun anEnrolledAuthenticatorAsksForACodeAndKeepsNothing() = runTest {
        val storage = FakeStorage()
        val answer = """{"result":"mfa_required","challengeId":"c1","factors":[{"method":"passkey","id":"p"},{"method":"authenticator","id":"f"}]}"""
        val manager = managerOver(storage) { respond(answer, HttpStatusCode.OK, JSON) }

        val result = manager.signIn(SERVER, "op@example.com", "hunter2") as SignInResult.CodeNeeded
        assertEquals("c1", result.challengeId)
        assertEquals(listOf("f"), result.factors.map { it.id })
        assertNull(storage.stored.value)
    }

    @Test
    fun aPasskeyOnlyAccountIsToldSo() = runTest {
        val answer = """{"result":"mfa_required","challengeId":"c1","factors":[{"method":"passkey","id":"p"}]}"""
        val manager = managerOver(FakeStorage()) { respond(answer, HttpStatusCode.OK, JSON) }

        assertEquals(SignInResult.PasskeyOnly, manager.signIn(SERVER, "op@example.com", "hunter2"))
    }

    @Test
    fun aWrongPasswordAndTheRateLimiterReadDifferently() = runTest {
        val wrong = managerOver(FakeStorage()) { refused() }
        val limited = managerOver(FakeStorage()) { respond("", HttpStatusCode.TooManyRequests) }

        assertEquals(SignInResult.BadCredentials, wrong.signIn(SERVER, "op@example.com", "no"))
        assertEquals(SignInResult.TooManyAttempts, limited.signIn(SERVER, "op@example.com", "no"))
    }

    @Test
    fun aTokenWithNothingToRenewItIsNotKept() = runTest {
        val storage = FakeStorage()
        val manager = managerOver(storage) { respond("""{"result":"token","accessToken":"a"}""", HttpStatusCode.OK, JSON) }

        assertTrue(manager.signIn(SERVER, "op@example.com", "hunter2") is SignInResult.Failed)
        assertNull(storage.stored.value)
    }

    @Test
    fun aRefreshIsSentAsTheRefreshGrant() = runTest {
        var sent = ""
        val manager = managerOver(FakeStorage(SIGNED_IN)) { sent = it.bodyText(); respond(ROTATED, HttpStatusCode.OK, JSON) }

        manager.refreshed("old-access")
        assertTrue(sent, "\"grant_type\":\"refresh_token\"" in sent && "\"refresh_token\":\"old-refresh\"" in sent)
    }

    @Test
    fun twoCallersMeetingOneExpiryRefreshOnce() = runTest {
        val refreshes = AtomicInteger()
        val manager =
            managerOver(FakeStorage(SIGNED_IN)) { request ->
                when {
                    request.url.encodedPath.endsWith("/token") -> { refreshes.incrementAndGet(); respond(ROTATED, HttpStatusCode.OK, JSON) }
                    request.headers[HttpHeaders.Authorization] == "Bearer new-access" -> respond(SESSION, HttpStatusCode.OK, JSON)
                    else -> respond("", HttpStatusCode.Unauthorized)
                }
            }

        List(5) { async { manager.call { it.auth.getCurrentSession() } } }.awaitAll()
        assertEquals(1, refreshes.get())
    }

    @Test
    fun theApiRefusingTheRefreshEndsTheSession() = runTest {
        val storage = FakeStorage(SIGNED_IN)
        val manager = managerOver(storage) { refused() }

        assertNull(manager.refreshed("old-access"))
        assertNull(storage.stored.value)
    }

    @Test
    fun aRateLimiterOrProxyLeavesTheSessionAlone() = runTest {
        for (status in listOf(HttpStatusCode.TooManyRequests, HttpStatusCode.BadGateway, HttpStatusCode.Forbidden, HttpStatusCode.Unauthorized)) {
            val storage = FakeStorage(SIGNED_IN)
            val manager = managerOver(storage) { respond("", status) }
            try {
                manager.refreshed("old-access")
                fail("expected $status to raise")
            } catch (_: SessionUnavailableException) {
                assertNotNull(storage.stored.value)
            }
        }
    }

    @Test
    fun aDeadNetworkLeavesTheSessionAlone() = runTest {
        val storage = FakeStorage(SIGNED_IN)
        val manager = managerOver(storage) { throw IOException("no route") }
        try {
            manager.refreshed("old-access")
            fail("expected the failure to reach the caller")
        } catch (_: IOException) {
            assertNotNull(storage.stored.value)
        }
    }

    @Test
    fun signingOutClearsThePhoneEvenWithNoNetwork() = runTest {
        val storage = FakeStorage(SIGNED_IN)
        managerOver(storage) { throw IOException("no route") }.signOut()
        assertNull(storage.stored.value)
    }
}
