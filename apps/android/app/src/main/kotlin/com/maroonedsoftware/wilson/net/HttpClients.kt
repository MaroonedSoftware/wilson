package com.maroonedsoftware.wilson.net

import com.maroonedsoftware.wilson.sdk.WilsonSdk
import com.maroonedsoftware.wilson.sdk.runtime.SdkConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout

/**
 * The app's HTTP stacks. The generated SDK declares no engine, so choosing one is this app's job.
 *
 * Three clients because three kinds of call want different patience. [short] is for everything a
 * person waits on. [long] is for calls that do real work before answering: a merge runs the test
 * suite first, and a planning or chat turn waits for an agent. [stream] has no read limit at all,
 * because an event stream is silent for as long as nothing happens.
 */
object HttpClients {
    val short: HttpClient by lazy { client(SHORT_MS) }
    val long: HttpClient by lazy { client(LONG_MS) }

    val stream: HttpClient by lazy {
        HttpClient(OkHttp) {
            engine { config { readTimeout(java.time.Duration.ZERO) } }
            install(HttpTimeout) { connectTimeoutMillis = CONNECT_MS }
        }
    }

    private fun client(requestMs: Long) =
        HttpClient(OkHttp) {
            engine { config { readTimeout(java.time.Duration.ofMillis(requestMs)) } }
            install(HttpTimeout) {
                requestTimeoutMillis = requestMs
                connectTimeoutMillis = CONNECT_MS
            }
        }

    /** Cheap: it wraps a shared client, and the SDK never closes a client it was handed. */
    fun sdkFor(server: ServerUrl, patience: Patience, headers: suspend () -> Map<String, String>): WilsonSdk =
        WilsonSdk(
            SdkConfig(
                baseUrl = server.origin,
                headers = headers,
                httpClient = if (patience == Patience.LONG) long else short,
            ),
        )

    private const val CONNECT_MS = 10_000L
    private const val SHORT_MS = 20_000L
    private const val LONG_MS = 20 * 60_000L
}

/** How long a call may take. See [HttpClients]. */
enum class Patience { SHORT, LONG }
