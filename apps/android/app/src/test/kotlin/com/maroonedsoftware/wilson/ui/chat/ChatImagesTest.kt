package com.maroonedsoftware.wilson.ui.chat

import com.maroonedsoftware.wilson.auth.SessionManager
import com.maroonedsoftware.wilson.auth.SessionStorage
import com.maroonedsoftware.wilson.auth.StoredSession
import com.maroonedsoftware.wilson.sdk.WilsonSdk
import com.maroonedsoftware.wilson.sdk.models.ChatAttachment
import com.maroonedsoftware.wilson.sdk.runtime.SdkConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

private class Storage(session: StoredSession?) : SessionStorage {
    override val stored = MutableStateFlow(session)

    override suspend fun save(session: StoredSession) {
        stored.value = session
    }

    override suspend fun clear() {
        stored.value = null
    }
}

private const val ORIGIN = "https://wilson.example.com"
private val SIGNED_IN = StoredSession(ORIGIN, "op@example.com", "old-access", "old-refresh")
private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
private val IMAGE_HEADERS = headersOf(
    HttpHeaders.ContentType to listOf("image/png"),
    "X-Content-Type-Options" to listOf("nosniff"),
    "Content-Security-Policy" to listOf("default-src 'none'"),
)
private val JSON = headersOf(HttpHeaders.ContentType, "application/json")
private const val ROTATED = """{"result":"token","accessToken":"new-access","refreshToken":"new-refresh","expiresIn":3600,"tokenType":"Bearer"}"""

private fun attachment(filename: String) =
    ChatAttachment("1", filename, "image/png", 4, "hash", Instant.parse("2026-11-07T00:00:00Z"))

/** The state once the fetch has answered, which through the mock engine happens off the test's clock. */
private suspend fun <T> StateFlow<ImageLoad<T>>.settled(): ImageLoad<T> = first { it != ImageLoad.Loading }

class ChatImagesTest {
    private fun sessionOver(handle: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) =
        SessionManager(Storage(SIGNED_IN)) { server, _, headers ->
            WilsonSdk(SdkConfig(baseUrl = server.origin, headers = headers, httpClient = HttpClient(MockEngine { handle(it) })))
        }

    @Test
    fun anImageIsFetchedFromItsThreadWithTheSessionsBearer() = runTest {
        var asked: HttpRequestData? = null
        val session = sessionOver { asked = it; respond(PNG, HttpStatusCode.OK, IMAGE_HEADERS) }

        assertArrayEquals(PNG, fetchChatImage(session, "12", "34"))
        assertEquals("/api/chat/threads/12/attachments/34", asked?.url?.encodedPath)
        assertEquals("Bearer old-access", asked?.headers?.get(HttpHeaders.Authorization))
    }

    @Test
    fun imagesMeetingOneExpiryRefreshOnce() = runTest {
        val refreshes = AtomicInteger()
        val session =
            sessionOver { request ->
                when {
                    request.url.encodedPath.endsWith("/token") -> { refreshes.incrementAndGet(); respond(ROTATED, HttpStatusCode.OK, JSON) }
                    request.headers[HttpHeaders.Authorization] == "Bearer new-access" -> respond(PNG, HttpStatusCode.OK, IMAGE_HEADERS)
                    else -> respond("", HttpStatusCode.Unauthorized)
                }
            }
        val images = ChatImages(backgroundScope, { thread, id -> fetchChatImage(session, thread, id) }, { it })

        val loads = (1..5).map { images.load("12", "$it") }
        val settled = loads.map { it.settled() }

        assertEquals(1, refreshes.get())
        settled.forEach { assertArrayEquals(PNG, (it as ImageLoad.Loaded).image) }
    }

    @Test
    fun anImageLoadsThenShows() = runTest {
        val answer = CompletableDeferred<ByteArray>()
        val images = ChatImages(backgroundScope, { _, _ -> answer.await() }, { it.size })

        val load = images.load("12", "34")
        testScheduler.runCurrent()
        assertEquals(ImageLoad.Loading, load.value)

        answer.complete(PNG)
        testScheduler.runCurrent()
        assertEquals(ImageLoad.Loaded(4), load.value)
    }

    @Test
    fun aFailedFetchShowsAsFailed() = runTest {
        val images = ChatImages<ByteArray>(backgroundScope, { _, _ -> throw IOException("no route") }, { it })

        val load = images.load("12", "34")
        testScheduler.runCurrent()
        assertEquals(ImageLoad.Failed, load.value)
    }

    @Test
    fun aMissingImageShowsAsFailed() = runTest {
        val session = sessionOver { respond("", HttpStatusCode.NotFound) }
        val images = ChatImages(backgroundScope, { thread, id -> fetchChatImage(session, thread, id) }, { it })

        assertEquals(ImageLoad.Failed, images.load("12", "34").settled())
    }

    @Test
    fun bytesThatAreNoImageShowAsFailed() = runTest {
        val images = ChatImages<Int>(backgroundScope, { _, _ -> PNG }, { null })

        val load = images.load("12", "34")
        testScheduler.runCurrent()
        assertEquals(ImageLoad.Failed, load.value)
    }

    @Test
    fun anImageIsFetchedOnceForTheLifeOfTheScreen() = runTest {
        val fetches = AtomicInteger()
        val images = ChatImages(backgroundScope, { _, _ -> fetches.incrementAndGet(); PNG }, { it })

        val first = images.load("12", "34")
        testScheduler.runCurrent()
        assertSame(first, images.load("12", "34"))
        images.load("12", "35")
        testScheduler.runCurrent()
        assertEquals(2, fetches.get())
    }

    @Test
    fun eachImageIsDescribedByItsCaption() {
        assertEquals("Image: cat.png", imageCaption(0, 1, attachment("cat.png")))
        assertEquals("Image 2 of 3: dog.jpg", imageCaption(1, 3, attachment("dog.jpg")))
    }

    @Test
    fun aLargeImageIsDecodedSmallEnoughToDraw() {
        assertEquals(1, sampleSize(1024, 768, 2048))
        assertEquals(1, sampleSize(2048, 2048, 2048))
        assertEquals(2, sampleSize(4032, 3024, 2048))
        assertEquals(4, sampleSize(1000, 8000, 2048))
    }
}
