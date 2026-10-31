package com.maroonedsoftware.wilson.net

/** One Server-Sent Event. [id] is the last id the stream has named, to resume from. */
data class SseEvent(val event: String, val data: String, val id: String?)

/**
 * Turns the lines of a `text/event-stream` into events. Data lines join with newlines and a blank line
 * dispatches; comments and unknown fields are skipped. Pure, so the framing is tested without a socket.
 */
class SseReader {
    private var event = ""
    private val data = mutableListOf<String>()
    var lastId: String? = null
        private set

    fun line(line: String): SseEvent? {
        if (line.isEmpty()) {
            val ready = if (data.isEmpty()) null else SseEvent(event.ifEmpty { "message" }, data.joinToString("\n"), lastId)
            event = ""
            data.clear()
            return ready
        }
        val colon = line.indexOf(':')
        if (colon == 0) return null
        val field = if (colon == -1) line else line.substring(0, colon)
        val value = if (colon == -1) "" else line.substring(colon + 1).removePrefix(" ")
        when (field) {
            "event" -> event = value
            "data" -> data += value
            "id" -> if ('\u0000' !in value) lastId = value
        }
        return null
    }
}

/** Doubling from a second to thirty, so a server restart is noticed quickly and an outage is not hammered. */
fun reconnectDelayMs(attempt: Int): Long = (1_000L shl attempt.coerceIn(0, 5)).coerceAtMost(30_000L)
