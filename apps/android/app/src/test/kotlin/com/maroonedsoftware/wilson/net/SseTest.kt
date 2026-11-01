package com.maroonedsoftware.wilson.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SseTest {
    private fun read(vararg lines: String) = SseReader().let { reader -> lines.mapNotNull(reader::line) }

    @Test
    fun aBlankLineDispatches() = assertEquals(listOf(SseEvent("card", "{}", null)), read("event: card", "data: {}", ""))

    @Test
    fun dataLinesJoin() = assertEquals("a\nb", read("data: a", "data: b", "").single().data)

    @Test
    fun anUnnamedEventIsAMessage() = assertEquals("message", read("data: a", "").single().event)

    @Test
    fun commentsAndHeartbeatsAreNothing() = assertEquals(emptyList<SseEvent>(), read(": ping", "", "retry: 5", ""))

    @Test
    fun theIdOutlivesItsEvent() {
        val events = read("id: 7", "data: a", "", "data: b", "")
        assertEquals(listOf("7", "7"), events.map { it.id })
    }

    @Test
    fun onlyOneSpaceIsStripped() = assertEquals(" a", read("data:  a", "").single().data)

    @Test
    fun anEventCutOffByTheEndOfTheStreamIsNotDispatched() = assertEquals(emptyList<SseEvent>(), read("event: card", "data: {}"))

    @Test
    fun aNulInAnIdIgnoresIt() = assertNull(SseReader().also { it.line("id: a\u0000b") }.lastId)

    @Test
    fun reconnectingBacksOffAndStops() = assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), (0..6).map(::reconnectDelayMs))
}
