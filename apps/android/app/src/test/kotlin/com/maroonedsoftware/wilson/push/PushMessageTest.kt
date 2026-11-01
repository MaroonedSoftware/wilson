package com.maroonedsoftware.wilson.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushMessageTest {
    private fun message(moment: String) = PushMessage(moment, "wilson", "0050")

    @Test
    fun theWiresShapeIsRead() =
        assertEquals(message("needs-human"), PushMessage.from(mapOf("moment" to "needs-human", "project" to "wilson", "cardId" to "0050")))

    @Test
    fun aMessageMissingAnIdIsNotOurs() = assertNull(PushMessage.from(mapOf("moment" to "manual", "project" to "wilson")))

    @Test
    fun eachMomentGoesToItsChannel() {
        assertEquals(PushChannel.GATES, message("manual").channel)
        assertEquals(PushChannel.NEEDS_YOU, message("needs-human").channel)
        assertEquals(PushChannel.NEEDS_YOU, message("poisoned").channel)
        assertEquals(PushChannel.UPDATES, message("source-closed").channel)
    }

    @Test
    fun aMomentThisBuildHasNotHeardOfStillAsks() {
        assertEquals(PushChannel.NEEDS_YOU, message("new-moment").channel)
        assertEquals("Card 0050 needs a look", message("new-moment").headline())
    }

    @Test
    fun theHeadlineNamesTheCardWithoutItsTitle() = assertEquals("Card 0050 needs you", message("needs-human").headline())
}
