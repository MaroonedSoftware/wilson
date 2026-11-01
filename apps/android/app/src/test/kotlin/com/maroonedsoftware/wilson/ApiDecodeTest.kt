package com.maroonedsoftware.wilson

import com.maroonedsoftware.wilson.sdk.models.BoardColumns
import com.maroonedsoftware.wilson.sdk.models.CardDetail
import com.maroonedsoftware.wilson.sdk.models.CardEvent
import com.maroonedsoftware.wilson.sdk.models.CardSummary
import com.maroonedsoftware.wilson.sdk.models.CardUsage
import com.maroonedsoftware.wilson.sdk.models.ChatThread
import com.maroonedsoftware.wilson.sdk.models.ChatThreadDetail
import com.maroonedsoftware.wilson.sdk.models.CurrentSession
import com.maroonedsoftware.wilson.sdk.models.Health
import com.maroonedsoftware.wilson.sdk.models.Project
import com.maroonedsoftware.wilson.sdk.models.TokenResponse
import com.maroonedsoftware.wilson.sdk.models.TokenResponseResult
import com.maroonedsoftware.wilson.sdk.runtime.SdkJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A generator can be self-consistent and still wrong about the API, and compiling proves nothing about
 * that. These are responses the real API gave, from a run of its test server, with the tokens
 * redacted. Decoding them is the gate for the shapes sign-in and the board depend on.
 */
class ApiDecodeTest {
    private fun fixture(name: String) = checkNotNull(javaClass.getResource("/api/$name.json")) { "no fixture $name" }.readText()

    private inline fun <reified T> decode(name: String): T = SdkJson.decodeFromString(fixture(name))

    @Test
    fun aSignIn() {
        val token: TokenResponse = decode("token")
        assertEquals(TokenResponseResult.TOKEN, token.result)
        assertEquals("redacted", token.accessToken)
        assertEquals("redacted", token.refreshToken)
    }

    @Test
    fun theSession() = assertEquals("operator@example.com", decode<CurrentSession>("session").email)

    @Test
    fun theBoard() {
        val columns: BoardColumns = decode("columns")
        assertTrue(columns.stages.isNotEmpty())
        assertTrue(decode<List<CardSummary>>("cards").isNotEmpty())
    }

    @Test
    fun aCard() {
        assertEquals("Body", decode<CardDetail>("card").body.trim())
        decode<List<CardEvent>>("events")
        assertEquals(0, decode<CardUsage>("usage").stages.size)
    }

    @Test
    fun theRest() {
        assertTrue(decode<List<Project>>("projects").isNotEmpty())
        decode<Health>("health")
        assertTrue(decode<List<ChatThread>>("threads").isNotEmpty())
        assertEquals(0, decode<ChatThreadDetail>("thread-detail").messages.size)
    }
}
