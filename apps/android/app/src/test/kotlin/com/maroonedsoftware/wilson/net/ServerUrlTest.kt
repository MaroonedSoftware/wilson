package com.maroonedsoftware.wilson.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlTest {
    private fun https(text: String) = ServerUrl.parse(text, allowCleartext = false)?.origin

    @Test
    fun aBareHostMeansHttps() = assertEquals("https://wilson.example.com", https(" Wilson.Example.com/ "))

    @Test
    fun aPortIsKept() = assertEquals("https://tower.local:13101", https("https://tower.local:13101"))

    @Test
    fun cleartextNeedsADebugBuild() {
        assertNull(https("http://10.0.2.2:13100"))
        assertEquals("http://10.0.2.2:13100", ServerUrl.parse("http://10.0.2.2:13100", allowCleartext = true)?.origin)
    }

    @Test
    fun anAddressNamesAPlaceAndNothingElse() {
        assertNull(https("https://me:secret@wilson.example.com"))
        assertNull(https("https://wilson.example.com/api"))
        assertNull(https("ftp://wilson.example.com"))
        assertNull(https("not an address"))
        assertNull(https(""))
    }
}
