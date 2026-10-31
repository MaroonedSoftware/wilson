package com.maroonedsoftware.wilson.auth

import com.maroonedsoftware.wilson.net.SseEvent
import com.maroonedsoftware.wilson.net.SseReader
import com.maroonedsoftware.wilson.net.reconnectDelayMs
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.isSuccess
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow

/** What a live stream has to say: whether it is connected, and what arrived. */
sealed interface StreamSignal {
    data object Live : StreamSignal

    data object Down : StreamSignal

    data class Event(val event: SseEvent) : StreamSignal
}

private class Unauthorized : Exception()

/**
 * An event stream held open for as long as it is collected, reconnecting after any drop and resuming
 * from the last id it saw. These routes are not in the contracts, so the generated SDK has no method
 * for them. Ends only when the session does, because nothing else makes reconnecting pointless.
 *
 * A 401 goes through [SessionManager.refreshed], so a stream shares the one refresh every other call
 * does. [Down] then says a drop happened; a screen that needs what it missed reads it on [Live].
 */
fun SessionManager.liveStream(client: HttpClient, path: String, project: String?, resumeFrom: String? = null): Flow<StreamSignal> = flow {
    var lastId = resumeFrom
    var attempt = 0
    while (true) {
        val current = session.first() ?: return@flow
        val reader = SseReader()
        try {
            client.prepareGet("${current.origin}$path") {
                headersFor(current, project).forEach { (name, value) -> header(name, value) }
                header("Accept", "text/event-stream")
                lastId?.let { header("Last-Event-ID", it) }
            }.execute { response ->
                if (response.status.value == 401) throw Unauthorized()
                if (!response.status.isSuccess()) throw java.io.IOException("Stream answered ${response.status.value}")
                attempt = 0
                emit(StreamSignal.Live)
                val channel = response.bodyAsChannel()
                while (true) {
                    val line = channel.readUTF8Line() ?: break
                    reader.line(line)?.let { event ->
                        lastId = event.id ?: lastId
                        emit(StreamSignal.Event(event))
                    }
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Unauthorized) {
            try {
                refreshed(current.accessToken) ?: return@flow
            } catch (_: Exception) {
                // The session stands and the server is not answering, which the delay below is for.
            }
        } catch (_: Exception) {
            // Any drop is the same to a stream: say so and go round again.
        }
        emit(StreamSignal.Down)
        delay(reconnectDelayMs(attempt++))
    }
}
