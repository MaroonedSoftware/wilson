package com.maroonedsoftware.wilson.ui.board

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardFeedTest {
    @Test
    fun theFeedsOwnShapeIsRead() {
        assertTrue(isToolEvent("""{"id":1,"ts":"2026-10-31T00:00:00Z","message":"tool.executed","correlationId":"0001","data":{"stage":"testing"}}"""))
        assertFalse(isToolEvent("""{"id":2,"ts":"2026-10-31T00:00:00Z","message":"stage.passed","correlationId":"0001"}"""))
    }

    @Test
    fun whatCannotBeReadReloads() = assertFalse(isToolEvent("not json"))
}
