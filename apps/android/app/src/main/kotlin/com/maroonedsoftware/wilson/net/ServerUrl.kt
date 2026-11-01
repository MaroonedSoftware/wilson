package com.maroonedsoftware.wilson.net

import java.net.URI
import java.net.URISyntaxException

/** Where a Wilson API answers, always as a bare origin: scheme, host and any port, no trailing slash. */
@JvmInline
value class ServerUrl(val origin: String) {
    companion object {
        private val BARE_IPV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}(:\d+)?(/.*)?$""")

        /** A space a keyboard or a paste left beside a separator. Any other space means it is not an address. */
        private val SPACE_BESIDE_SEPARATOR = Regex("""\s*([.:/])\s*""")

        /**
         * Reads a typed or pasted address, or null when it is not one. A bare host means https, but a
         * bare IP means http wherever http is allowed, because an IP has no certificate to offer. Plain
         * http is refused unless [allowCleartext], which only a debug build passes. A path, query or
         * fragment is dropped, so an address bar can be pasted whole. A user or password is refused
         * outright: an address names a place, never a way in.
         */
        fun parse(text: String, allowCleartext: Boolean): ServerUrl? {
            val trimmed = text.trim().replace(SPACE_BESIDE_SEPARATOR, "$1").trimEnd('/')
            if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
            // `http:/host` is a slipped slash, not a host called http.
            if (":/" in trimmed && "://" !in trimmed) return null
            val assumed = if (allowCleartext && BARE_IPV4.matches(trimmed)) "http" else "https"
            val uri =
                try {
                    URI(if ("://" in trimmed) trimmed else "$assumed://$trimmed")
                } catch (_: URISyntaxException) {
                    return null
                }
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host ?: return null
            if (uri.userInfo != null || scheme !in setOf("http", "https")) return null
            if (scheme == "http" && !allowCleartext) return null
            return ServerUrl("$scheme://${host.lowercase()}${if (uri.port == -1) "" else ":${uri.port}"}")
        }
    }
}
