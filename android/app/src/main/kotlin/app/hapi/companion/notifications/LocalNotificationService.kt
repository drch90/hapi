package app.hapi.companion.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.hapi.companion.HapiApp
import app.hapi.companion.MainActivity
import app.hapi.companion.R
import app.hapi.companion.di.localizedForAppLanguage
import app.hapi.data.sse.ConnectionState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest

/** Started only by a visible activity. No boot receiver and no automatic resurrection. */
internal class LocalNotificationService : Service() {
    private val graph get() = (application as HapiApp).appGraph
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var reception: Job? = null
    private var observer: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            graph.localNotifications.setEnabled(false)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!graph.localNotifications.enabled.value || !canNotify(this)) {
            graph.localNotifications.status.value = if (canNotify(this)) ReceptionStatus.Stopped else ReceptionStatus.PermissionRequired
            stopSelf()
            return START_NOT_STICKY
        }
        if (reception?.isActive == true) return START_NOT_STICKY
        try {
            ensureChannel(this)
            ServiceCompat.startForeground(this, SERVICE_ID, statusNotification(ReceptionStatus.Connecting, null),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        } catch (_: RuntimeException) {
            graph.localNotifications.status.value = ReceptionStatus.StartFailed
            stopSelf()
            return START_NOT_STICKY
        }
        observer = scope.launch {
            graph.localNotifications.enabled.collect { enabled -> if (!enabled) stopSelf() }
        }
        reception = scope.launch {
            graph.awaitReady()
            graph.activeHubGraph.collectLatest { hub ->
                if (hub == null) {
                    // The graph is populated just after the roster's ready flag.
                    if (graph.hubRegistry.activeHubUrl == null) {
                        graph.localNotifications.status.value = ReceptionStatus.PairingRequired
                        stopSelf()
                    }
                    return@collectLatest
                }
                coroutineScope {
                    val binding = launch {
                        LocalNotificationReceiver(this@LocalNotificationService, graph, hub).run()
                    }
                    val auth = launch {
                        graph.authTerminals.collect { terminal ->
                            if (terminal.hubUrl == hub.hubUrl) {
                                graph.localNotifications.status.value = ReceptionStatus.PairingRequired
                                stopSelf()
                            }
                        }
                    }
                    try {
                        hub.sseEngine.connectionState(app.hapi.data.sse.SseSubscriptionKey.Global).collect { state ->
                            if (!canNotify(this@LocalNotificationService)) {
                                graph.localNotifications.status.value = ReceptionStatus.PermissionRequired
                                stopSelf()
                                return@collect
                            }
                            val status = when (state.phase) {
                                ConnectionState.Phase.Connected -> ReceptionStatus.Connected
                                ConnectionState.Phase.Backoff, ConnectionState.Phase.Suspended -> ReceptionStatus.Reconnecting
                                else -> ReceptionStatus.Connecting
                            }
                            graph.localNotifications.status.value = status
                            try {
                                getSystemService(NotificationManager::class.java).notify(SERVICE_ID, statusNotification(status, hub.hubUrl))
                            } catch (_: SecurityException) {
                                graph.localNotifications.status.value = ReceptionStatus.PermissionRequired
                                stopSelf()
                            }
                        }
                    } finally {
                        binding.cancelAndJoin()
                        auth.cancelAndJoin()
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun statusNotification(status: ReceptionStatus, hub: String?): android.app.Notification {
        val context = localizedForAppLanguage(graph.appLanguage.value)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 0, Intent(this, LocalNotificationService::class.java).setAction(STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hapi)
            .setContentTitle(context.getString(R.string.local_notifications_title))
            .setContentText(listOfNotNull(context.getString(status.label()), hub).joinToString(" · "))
            .setContentIntent(open)
            // Android 12+ otherwise defers a new FGS notification for about
            // ten seconds, hiding the connection state after the user enables it.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_hapi).setContentTitle(context.getString(R.string.local_notifications_title)).build())
            .addAction(0, context.getString(R.string.local_notifications_open), open)
            .addAction(0, context.getString(R.string.local_notifications_stop), stop)
            .build()
    }

    override fun onDestroy() {
        scope.cancel()
        if (graph.localNotifications.status.value !in setOf(ReceptionStatus.PairingRequired, ReceptionStatus.PermissionRequired, ReceptionStatus.StartFailed)) {
            graph.localNotifications.status.value = ReceptionStatus.Stopped
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "local_notification_connection"
        private const val SERVICE_ID = 0x484150
        private const val STOP = "app.hapi.companion.notifications.STOP"

        fun canNotify(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

        fun startIfEnabled(context: Context) {
            val graph = (context.applicationContext as HapiApp).appGraph
            if (!graph.localNotifications.enabled.value || graph.hubRegistry.activeHubUrl == null) return
            if (!canNotify(context)) {
                graph.localNotifications.status.value = ReceptionStatus.PermissionRequired
                return
            }
            try {
                ContextCompat.startForegroundService(context, Intent(context, LocalNotificationService::class.java))
            } catch (_: RuntimeException) {
                graph.localNotifications.status.value = ReceptionStatus.StartFailed
            }
        }

        fun stop(context: Context) {
            val settings = (context.applicationContext as HapiApp).appGraph.localNotifications
            settings.setEnabled(false)
            settings.status.value = ReceptionStatus.Stopped
            context.stopService(Intent(context, LocalNotificationService::class.java))
        }

        private fun ensureChannel(context: Context) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.local_notifications_title), NotificationManager.IMPORTANCE_LOW))
        }
    }
}

internal fun ReceptionStatus.label(): Int = when (this) {
    ReceptionStatus.Stopped -> R.string.local_notifications_stopped
    ReceptionStatus.Connecting -> R.string.local_notifications_connecting
    ReceptionStatus.Connected -> R.string.local_notifications_connected
    ReceptionStatus.Reconnecting -> R.string.local_notifications_reconnecting
    ReceptionStatus.PermissionRequired -> R.string.local_notifications_permission
    ReceptionStatus.PairingRequired -> R.string.local_notifications_pairing
    ReceptionStatus.StartFailed -> R.string.local_notifications_start_failed
}
