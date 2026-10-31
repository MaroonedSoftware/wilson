package com.maroonedsoftware.wilson

import org.junit.Assert.assertEquals
import org.junit.Test

/** Proves the unit-test source set runs; replaced by real tests in later phases. */
class ScaffoldTest {
    @Test
    fun testsRun() {
        assertEquals("com.maroonedsoftware.wilson", MainActivity::class.java.packageName)
    }
}
