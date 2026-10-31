package com.maroonedsoftware.wilson.net

import java.net.URI
import java.net.URISyntaxException

/** Where a Wilson API answers, always as a bare origin: scheme, host and any port, no trailing slash. */
@JvmInline
value class ServerUrl(val origin: String) {
    companion object {
        /**
         * Reads a typed address, or null when it is not one. A bare host means https. Plain http is
         * refused unless [allowCleartext], which only a debug build passes, and a user or password in
         * the address is refused outright: an address names a place, never a way in.
         */
        fun parse(text: String, allowCleartext: Boolean): ServerUrl? {
            val trimmed = text.trim().trimEnd('/')
            if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
            val uri =
                try {
                    URI(if ("://" in trimmed) trimmed else "https://$trimmed")
                } catch (_: URISyntaxException) {
                    return null
                }
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host ?: return null
            if (uri.userInfo != null || scheme !in setOf("http", "https")) return null
            if (scheme == "http" && !allowCleartext) return null
            if (!uri.path.isNullOrEmpty() || uri.query != null) return null
            return ServerUrl("$scheme://${host.lowercase()}${if (uri.port == -1) "" else ":${uri.port}"}")
        }
    }
}
