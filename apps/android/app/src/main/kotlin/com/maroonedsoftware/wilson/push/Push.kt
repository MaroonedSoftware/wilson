package com.maroonedsoftware.wilson.push

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.getSystemService
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.maroonedsoftware.wilson.MainActivity
import com.maroonedsoftware.wilson.R
import com.maroonedsoftware.wilson.WilsonApp
import com.maroonedsoftware.wilson.auth.SessionManager
import com.maroonedsoftware.wilson.sdk.models.RegisterDeviceRequest
import com.maroonedsoftware.wilson.sdk.models.UnregisterDeviceRequest
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

const val EXTRA_PROJECT = "wilson.project"
const val EXTRA_CARD = "wilson.card"

private const val TITLE_FETCH_MS = 8_000L

fun createNotificationChannels(context: Context) {
    val manager = context.getSystemService<NotificationManager>() ?: return
    PushChannel.entries.forEach { channel ->
        val importance = if (channel == PushChannel.UPDATES) NotificationManager.IMPORTANCE_DEFAULT else NotificationManager.IMPORTANCE_HIGH
        manager.createNotificationChannel(NotificationChannel(channel.id, channel.label, importance))
    }
}

/**
 * Tells the API where this install can be reached. With no `google-services.json` in the build there
 * is no Firebase app, so [register] does nothing and everything else works as ever.
 */
class PushRegistrar(private val context: Context, private val session: SessionManager) {
    private val available get() = FirebaseApp.getApps(context).isNotEmpty()

    private suspend fun token(): String? =
        suspendCancellableCoroutine { waiting ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task -> waiting.resume(task.result.takeIf { task.isSuccessful }) }
        }

    suspend fun register(known: String? = null) {
        if (!available) return
        val token = known ?: token() ?: return
        if (session.session.first() == null) return
        // A failure here is retried by the next launch, and costs nothing until then.
        runCatching { session.call { it.devices.registerDevice(RegisterDeviceRequest(token, Build.MODEL)) } }
    }

    /** Signs out, taking this phone off the list first while there is still a session to do it with. */
    suspend fun signOut() {
        val token = if (available) token() else null
        session.signOut { sdk -> if (token != null) sdk.devices.unregisterDevice(UnregisterDeviceRequest(token)) }
    }
}

/** Runs on Firebase's own background thread, which is why waiting briefly for the title is allowed. */
class WilsonMessagingService : FirebaseMessagingService() {
    private val app get() = application as WilsonApp

    override fun onNewToken(token: String) {
        runBlocking { app.push.register(token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val push = PushMessage.from(message.data) ?: return
        val title = runBlocking {
            if (app.session.session.first() == null) return@runBlocking null
            withTimeoutOrNull(TITLE_FETCH_MS) { runCatching { app.session.call(push.project) { it.board.getCard(push.cardId).title } }.getOrNull() }
        }
        show(push, title)
    }

    // Checked in the first lines below, in a form lint cannot follow past the SDK test.
    @SuppressLint("MissingPermission")
    private fun show(push: PushMessage, title: String?) {
        // Asked for at sign-in; a person who said no simply gets no notification.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ) {
            return
        }
        val manager = NotificationManagerCompat.from(this)
        val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_PROJECT, push.project)
            .putExtra(EXTRA_CARD, push.cardId)
        val notificationId = "${push.project}:${push.cardId}".hashCode()
        val tap = PendingIntent.getActivity(this, notificationId, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(this, push.channel.id)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(push.headline())
            .setContentText(title)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        manager.notify(notificationId, notification)
    }
}
