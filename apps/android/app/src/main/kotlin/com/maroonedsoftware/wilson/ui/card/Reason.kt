package com.maroonedsoftware.wilson.ui.card

import com.maroonedsoftware.wilson.sdk.runtime.SdkError
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** The server's own sentence for a refusal, as the web app's `reasonFor` reads it. */
fun reasonFor(error: Throwable): String =
    if (error is SdkError) reasonIn(error.json) ?: "The server answered ${error.status}." else error.message ?: "Something went wrong."

internal fun reasonIn(body: JsonElement?): String? {
    val root = body as? JsonObject ?: return null
    val details = root["details"] as? JsonObject
    return (details?.get("reason") ?: root["message"])?.jsonPrimitive?.contentOrNull
}
