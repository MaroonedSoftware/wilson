package com.maroonedsoftware.wilson.auth

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.sessionPreferences by preferencesDataStore("session")

/**
 * The tokens, in a file of their own so that clearing a session cannot take the server address with it.
 *
 * Not encrypted at rest, as deadair's are not: the file is app-private, `allowBackup="false"` and
 * `data_extraction_rules.xml` keep it on this phone, `security-crypto` is deprecated, and anything
 * that can read app-private storage can read a keystore-wrapped copy too.
 */
class SessionStore(private val context: Context) : SessionStorage {
    override val stored: Flow<StoredSession?> =
        context.sessionPreferences.data.map { saved ->
            val origin = saved[ORIGIN]
            val email = saved[EMAIL]
            val access = saved[ACCESS_TOKEN]
            val refresh = saved[REFRESH_TOKEN]
            // All or nothing: a refresh token is single-use, so half a session is already spent.
            if (origin == null || email == null || access == null || refresh == null) null else StoredSession(origin, email, access, refresh)
        }

    override suspend fun save(session: StoredSession) {
        context.sessionPreferences.edit { saved ->
            saved[ORIGIN] = session.origin
            saved[EMAIL] = session.email
            saved[ACCESS_TOKEN] = session.accessToken
            saved[REFRESH_TOKEN] = session.refreshToken
        }
    }

    override suspend fun clear() {
        context.sessionPreferences.edit { it.clear() }
    }

    private companion object {
        val ORIGIN = stringPreferencesKey("origin")
        val EMAIL = stringPreferencesKey("email")
        val ACCESS_TOKEN = stringPreferencesKey("access_token")
        val REFRESH_TOKEN = stringPreferencesKey("refresh_token")
    }
}
