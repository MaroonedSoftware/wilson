package com.maroonedsoftware.wilson.ui.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

private fun fields(text: String) = actionFields(json(text))

private fun line(label: String, value: String) = ChatActionField(label, value, ChatFieldKind.LINE)

class ChatArgumentsTest {
    @Test
    fun aRequestBodyIsOpenedAndItsNamesMadeReadable() = assertEquals(
        listOf(line("ID", "0003"), line("Stage", "review"), line("Web access", "none")),
        fields("""{"id":"0003","body":{"stage":"review","web_access":"none"}}"""),
    )

    @Test
    fun aBodyStaysWholeWhenItsNamesClashSoNothingReadsTwice() {
        val result = fields("""{"id":"1","body":{"id":"2"}}""")

        assertEquals(listOf("ID", "Body"), result.map { it.label })
        assertEquals(ChatFieldKind.JSON, result[1].kind)
        assertTrue(result[1].value.contains("\"2\""))
    }

    @Test
    fun aBodyThatIsNotAnObjectIsAnyOtherArgument() = assertEquals(listOf(line("Body", "text")), fields("""{"body":"text"}"""))

    @Test
    fun aBodyInsideABodyIsTheCardsTextAfterTheShortValues() {
        val result = fields("""{"body":{"body":"## Goal\n\nRead it.","stage":"parking-lot","title":"A card"}}""")

        assertEquals(listOf("Stage", "Title", "Body"), result.map { it.label })
        assertEquals(ChatActionField("Body", "## Goal\n\nRead it.", ChatFieldKind.PROSE), result[2])
    }

    @Test
    fun longTextIsProseEvenOnOneLine() {
        assertEquals(ChatFieldKind.LINE, fields("""{"note":"${"a".repeat(120)}"}""")[0].kind)
        assertEquals(ChatFieldKind.PROSE, fields("""{"note":"${"a".repeat(121)}"}""")[0].kind)
    }

    @Test
    fun everyKindOfValueIsShownInOrder() {
        val result = fields("""{"f":{"g":1},"e":["x"],"long":"one\ntwo","a":null,"b":true,"c":3,"d":""}""")

        assertEquals(listOf("A", "B", "C", "D", "Long", "F", "E"), result.map { it.label })
        assertEquals(listOf("none", "true", "3", "(empty)"), result.take(4).map { it.value })
        assertTrue(result.take(4).all { it.kind == ChatFieldKind.LINE })
        assertEquals(ChatFieldKind.PROSE, result[4].kind)
        assertEquals("{\n  \"g\": 1\n}", result[5].value)
        assertEquals(ChatFieldKind.JSON, result[6].kind)
        assertTrue(result[6].value.contains("\"x\""))
    }

    @Test
    fun noArgumentsMeansNoFields() = assertEquals(emptyList<ChatActionField>(), fields("{}"))

    @Test
    fun argumentsThatAreNotAnObjectAreStillShown() = assertEquals(listOf(ChatActionField("Arguments", "3", ChatFieldKind.JSON)), fields("3"))

    @Test
    fun namesReadAsLabels() {
        mapOf(
            "webAccess" to "Web access",
            "web_access" to "Web access",
            "web-access" to "Web access",
            "cardId" to "Card ID",
            "id" to "ID",
            "title" to "Title",
            "_" to "_",
        ).forEach { (name, label) -> assertEquals(label, fieldLabel(name)) }
    }

    @Test
    fun theRawViewIndentsAndLeavesTextAlone() =
        assertEquals("{\n  \"body\": {\n    \"title\": \"café <b>\"\n  }\n}", prettyArguments(json("""{"body":{"title":"café <b>"}}""")))
}
