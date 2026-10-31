package com.maroonedsoftware.wilson.settings

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.settingsPreferences by preferencesDataStore("settings")

/** What outlives a session: which server this install talks to, and the last project on screen. */
class SettingsStore(private val context: Context) {
    val server: Flow<String?> = context.settingsPreferences.data.map { it[SERVER] }
    val project: Flow<String?> = context.settingsPreferences.data.map { it[PROJECT] }

    suspend fun saveServer(origin: String) {
        context.settingsPreferences.edit { it[SERVER] = origin }
    }

    suspend fun saveProject(name: String) {
        context.settingsPreferences.edit { it[PROJECT] = name }
    }

    private companion object {
        val SERVER = stringPreferencesKey("server")
        val PROJECT = stringPreferencesKey("project")
    }
}
