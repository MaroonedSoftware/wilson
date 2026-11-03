package com.maroonedsoftware.wilson.ui.card

import com.maroonedsoftware.wilson.sdk.runtime.SdkError
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** The server's own sentence for a refusal, as the web app's `reasonFor` reads it. */
fun reasonFor(error: Throwable): String =
    if (error is SdkError) reasonIn(error.json) ?: noReason(error.status) else error.message ?: "Something went wrong."

/** A proxy's answer has no reason in it: the API sends its own failures as JSON, and Cloudflare swaps an origin's 502 for its own page. */
internal fun noReason(status: Int): String =
    if (status in 502..504) "Wilson's server could not be reached through the proxy in front of it ($status). It may be restarting."
    else "The server answered $status."

internal fun reasonIn(body: JsonElement?): String? {
    val root = body as? JsonObject ?: return null
    val details = root["details"] as? JsonObject
    return (details?.get("reason") ?: root["message"])?.jsonPrimitive?.contentOrNull
}
