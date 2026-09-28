package app.hapi.companion.feature.chat

import android.app.Notification
import android.app.NotificationManager
import android.os.Build
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.HapiApp
import app.hapi.companion.R
import app.hapi.companion.di.LocalAppGraph
import app.hapi.companion.fcm.PushNotifications
import app.hapi.companion.notifications.*
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.push.PushPayload
import app.hapi.data.push.PushType
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class LocalNotificationsTest {
    @get:Rule val compose = createComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val graph get() = (context.applicationContext as HapiApp).appGraph

    private fun grantNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            instrumentation.uiAutomation.executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
                .use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
        }
    }

    @Test fun localNotificationsArePrivateHaveNoActionsAndKeepHubIdentity() {
        grantNotifications()
        val payload = PushPayload(PushType.PERMISSION_REQUEST, "permission-request", "same-session", "Example session",
            null, "Approval needed", "Read a file", "request", null, "1", null)
        val hubs = listOf("http://127.0.0.1:3006", "http://127.0.0.1:3007")
        try {
            compose.setContent { HapiTheme { androidx.compose.material3.Text("Notification test") } }
            compose.runOnIdle {
                hubs.forEach { PushNotifications.show(context, payload, it, allowActions = false) }
            }
            compose.waitUntil(5000) {
                context.getSystemService(NotificationManager::class.java).activeNotifications
                    .count { it.notification.extras.getString(PushNotifications.EXTRA_SESSION_ID) == payload.sessionId } == 2
            }
            val notifications = context.getSystemService(NotificationManager::class.java).activeNotifications
                .filter { it.notification.extras.getString(PushNotifications.EXTRA_SESSION_ID) == payload.sessionId }
            assertEquals(2, notifications.map { it.tag }.toSet().size)
            assertEquals(2, notifications.map { it.notification.contentIntent }.toSet().size)
            assertEquals(hubs.toSet(), notifications.map { it.notification.extras.getString(PushNotifications.EXTRA_HUB_URL) }.toSet())
            notifications.forEach {
                assertEquals(Notification.VISIBILITY_PRIVATE, it.notification.visibility)
                assertTrue(it.notification.actions.isNullOrEmpty())
                assertNotNull(it.notification.publicVersion)
                assertFalse(it.notification.publicVersion.extras.toString().contains("Read a file"))
            }
        } finally {
            hubs.forEach { PushNotifications.cancel(context, PushNotifications.notificationTag(payload, it)) }
        }
    }

    @Test fun settingsStartAndStopForegroundReceptionWithoutFirebase() {
        grantNotifications()
        runBlocking { graph.awaitReady() }
        val oldHub = graph.hubRegistry.activeHubUrl
        val testHub = "http://127.0.0.1:1"
        val wasPaired = testHub in graph.hubRegistry.state.value.hubs
        val wasEnabled = graph.localNotifications.enabled.value
        try {
            runBlocking { graph.hubRegistry.addHub(testHub) }
            compose.setContent {
                HapiTheme {
                    CompositionLocalProvider(LocalAppGraph provides graph) { LocalNotificationSettingsView() }
                }
            }
            compose.runOnIdle { graph.localNotifications.setEnabled(false) }
            compose.onNode(isToggleable()).performClick()
            compose.waitUntil(5000) {
                context.getSystemService(NotificationManager::class.java).activeNotifications.any {
                    it.notification.channelId == "local_notification_connection"
                }
            }
            compose.runOnIdle {
                assertTrue(graph.localNotifications.enabled.value)
                assertTrue(LocalNotificationSettings(context).enabled.value)
            }
            compose.onNode(isToggleable()).performClick()
            compose.waitUntil(5000) {
                context.getSystemService(NotificationManager::class.java).activeNotifications.none {
                    it.notification.channelId == "local_notification_connection"
                }
            }
            compose.runOnIdle { assertFalse(graph.localNotifications.enabled.value) }
        } finally {
            LocalNotificationService.stop(context)
            runBlocking {
                if (!wasPaired) graph.hubRegistry.removeHub(testHub)
                if (oldHub != null) graph.hubRegistry.setActiveHub(oldHub)
            }
            graph.localNotifications.setEnabled(wasEnabled)
        }
    }
}
