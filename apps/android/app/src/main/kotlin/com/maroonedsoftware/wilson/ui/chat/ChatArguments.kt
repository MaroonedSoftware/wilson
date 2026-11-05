package com.maroonedsoftware.wilson.ui.chat

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** How a proposed action's argument is best read: beside its label, as long text, or as indented JSON. In display order. */
internal enum class ChatFieldKind { LINE, PROSE, JSON }

/** One argument of a proposed action, as a person reads it. */
internal data class ChatActionField(val label: String, val value: String, val kind: ChatFieldKind)

/** Past this a string is prose even on one line, and would not sit beside its label. */
private const val LONGEST_LINE = 120

private val WORD_BREAK = Regex("""(?<=[a-z0-9])(?=[A-Z])|[_\-\s]+""")

@OptIn(ExperimentalSerializationApi::class)
private val INDENTED = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}

/** The arguments exactly as recorded, for when the fields are not enough. */
internal fun prettyArguments(arguments: JsonElement): String = INDENTED.encodeToString(JsonElement.serializer(), arguments)

/** `webAccess` and `web_access` as `Web access`, and `cardId` as `Card ID`. */
internal fun fieldLabel(name: String): String {
    val words = name.split(WORD_BREAK).filter { it.isNotEmpty() }.map { it.lowercase() }.map { if (it == "id") "ID" else it }
    if (words.isEmpty()) return name
    return (listOf(words.first().replaceFirstChar { it.uppercase() }) + words.drop(1)).joinToString(" ")
}

/** A request's `body` is an API detail and is opened, unless that would leave two arguments of one name. */
private fun opened(arguments: JsonObject): List<Pair<String, JsonElement>> {
    val entries = arguments.entries.map { it.key to it.value }
    val body = arguments["body"] as? JsonObject ?: return entries
    if (body.keys.any { it != "body" && it in arguments }) return entries
    return entries.flatMap { entry -> if (entry.first == "body") body.entries.map { it.key to it.value } else listOf(entry) }
}

private fun field(name: String, value: JsonElement): ChatActionField {
    val label = fieldLabel(name)
    return when {
        value is JsonNull -> ChatActionField(label, "none", ChatFieldKind.LINE)
        value !is JsonPrimitive -> ChatActionField(label, prettyArguments(value), ChatFieldKind.JSON)
        !value.isString -> ChatActionField(label, value.content, ChatFieldKind.LINE)
        value.content.isEmpty() -> ChatActionField(label, "(empty)", ChatFieldKind.LINE)
        value.content.contains('\n') || value.content.length > LONGEST_LINE -> ChatActionField(label, value.content, ChatFieldKind.PROSE)
        else -> ChatActionField(label, value.content, ChatFieldKind.LINE)
    }
}

/**
 * A proposed action's arguments for the person deciding on it. Every argument is shown, since Confirm
 * runs exactly what is on the card. Short values come first: stored arguments are in jsonb's order,
 * which is no order a person would pick, and a long body would push the rest out of sight. The same
 * rules as the web app's `actionFields` and the desktop app's `ChatArguments`.
 */
internal fun actionFields(arguments: JsonElement): List<ChatActionField> {
    if (arguments !is JsonObject) return listOf(ChatActionField("Arguments", prettyArguments(arguments), ChatFieldKind.JSON))
    return opened(arguments).map { (name, value) -> field(name, value) }.sortedBy { it.kind }
}
