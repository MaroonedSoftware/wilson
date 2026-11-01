package com.maroonedsoftware.wilson.auth

import com.maroonedsoftware.wilson.net.ServerUrl
import com.maroonedsoftware.wilson.sdk.WilsonSdk
import com.maroonedsoftware.wilson.sdk.runtime.SdkConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

private class Memory(session: StoredSession?) : SessionStorage {
    override val stored = MutableStateFlow(session)

    override suspend fun save(session: StoredSession) {
        stored.value = session
    }

    override suspend fun clear() {
        stored.value = null
    }
}

class LiveStreamTest {
    private val signedIn = StoredSession("https://wilson.example.com", "op@example.com", "old", "refresh")
    private val sse = headersOf(HttpHeaders.ContentType, "text/event-stream")

    private fun manager(storage: SessionStorage) = SessionManager(storage) { server: ServerUrl, _, headers ->
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        WilsonSdk(
            SdkConfig(
                baseUrl = server.origin,
                headers = headers,
                httpClient = HttpClient(MockEngine { respond("""{"result":"token","accessToken":"new","refreshToken":"r2"}""", HttpStatusCode.OK, json) }),
            ),
        )
    }

    @Test
    fun aDropReconnectsAndResumesFromTheLastId() = runTest {
        val resumedWith = mutableListOf<String?>()
        val client = HttpClient(MockEngine { request ->
            resumedWith += request.headers["Last-Event-ID"]
            respond("id: ${resumedWith.size}\nevent: turn\ndata: {}\n\n", HttpStatusCode.OK, sse)
        })

        manager(Memory(signedIn)).liveStream(client, "/api/cards/1/plan/stream", "wilson").filterIsInstance<StreamSignal.Event>().take(2).toList()
        assertEquals(listOf(null, "1"), resumedWith)
    }

    @Test
    fun aStreamSendsTheBearerAndProject() = runTest {
        var bearer: String? = null
        var project: String? = null
        val client = HttpClient(MockEngine { request ->
            bearer = request.headers["Authorization"]
            project = request.headers["X-Wilson-Project"]
            respond("data: {}\n\n", HttpStatusCode.OK, sse)
        })

        manager(Memory(signedIn)).liveStream(client, "/api/feed", "wilson").first()
        assertEquals("Bearer old" to "wilson", bearer to project)
    }

    @Test
    fun anExpiredTokenRefreshesAndReconnects() = runTest {
        val client = HttpClient(MockEngine { request ->
            if (request.headers["Authorization"] == "Bearer new") respond("data: {}\n\n", HttpStatusCode.OK, sse) else respond("", HttpStatusCode.Unauthorized)
        })

        val first = manager(Memory(signedIn)).liveStream(client, "/api/feed", null).filterIsInstance<StreamSignal.Event>().first()
        assertEquals("{}", first.event.data)
    }

    @Test
    fun aStreamEndsWithTheSession() = runTest {
        val client = HttpClient(MockEngine { respond("", HttpStatusCode.OK, sse) })
        assertEquals(emptyList<StreamSignal>(), manager(Memory(null)).liveStream(client, "/api/feed", null).toList())
    }
}
