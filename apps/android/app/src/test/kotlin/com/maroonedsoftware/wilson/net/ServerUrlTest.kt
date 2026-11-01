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
        assertNull(https("ftp://wilson.example.com"))
        assertNull(https("not an address"))
        assertNull(https(""))
    }

    private fun debug(text: String) = ServerUrl.parse(text, allowCleartext = true)?.origin

    @Test
    fun aBareIpMeansHttpWhereHttpIsAllowed() {
        assertEquals("http://192.168.1.20:13101", debug("192.168.1.20:13101"))
        assertEquals("http://10.0.2.2", debug("10.0.2.2"))
        assertEquals("https://wilson.example.com", debug("wilson.example.com"))
    }

    @Test
    fun aBareIpIsHttpsInARelease() = assertEquals("https://192.168.1.20", https("192.168.1.20"))

    @Test
    fun aStatedSchemeWins() = assertEquals("https://192.168.1.20:443", debug("https://192.168.1.20:443"))

    @Test
    fun aKeyboardsSpacesAreTakenOut() {
        assertEquals("http://192.168.1.20:13101", debug("192. 168. 1. 20 : 13101"))
        assertEquals("https://wilson.example.com", debug("wilson. example. com"))
    }

    @Test
    fun aSlippedSlashIsNotAHostCalledHttp() = assertNull(debug("http:/192.168.1.20:13101"))

    @Test
    fun anAddressBarPastesWhole() =
        assertEquals("https://wilson.example.com", https("https://wilson.example.com/projects/wilson?tab=board#top"))
}
