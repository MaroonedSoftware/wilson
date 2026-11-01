package com.maroonedsoftware.wilson

import android.app.Application
import com.maroonedsoftware.wilson.auth.SessionManager
import com.maroonedsoftware.wilson.auth.SessionStore
import com.maroonedsoftware.wilson.net.HttpClients
import com.maroonedsoftware.wilson.push.PushRegistrar
import com.maroonedsoftware.wilson.push.createNotificationChannels
import com.maroonedsoftware.wilson.settings.SettingsStore

/** The app's one object graph, built by hand: there are too few pieces to want a framework. */
class WilsonApp : Application() {
    val settings by lazy { SettingsStore(this) }
    val session by lazy { SessionManager(SessionStore(this), HttpClients::sdkFor) }
    val push by lazy { PushRegistrar(this, session) }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels(this)
    }
}
