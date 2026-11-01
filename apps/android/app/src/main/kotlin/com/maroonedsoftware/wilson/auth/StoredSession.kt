package com.maroonedsoftware.wilson.auth

import kotlinx.coroutines.flow.Flow

/** One signed-in session. The password is never here, or anywhere else. */
data class StoredSession(val origin: String, val email: String, val accessToken: String, val refreshToken: String)

/** Where the session is kept. An interface so [SessionManager]'s policy runs on a plain JVM. */
interface SessionStorage {
    val stored: Flow<StoredSession?>

    suspend fun save(session: StoredSession)

    suspend fun clear()
}
