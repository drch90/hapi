package app.hapi.companion.feature.chat

import android.app.NotificationManager
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Base64
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.HapiApp
import app.hapi.companion.MainActivity
import app.hapi.companion.fcm.PushNotifications
import app.hapi.companion.notifications.LocalNotificationService
import app.hapi.data.auth.HubCredentials
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Real HTTP/SSE → real service → NotificationManager, with the activity on Home. */
class BackgroundNotificationDeliveryTest {
    @Test fun completionArrivesWhileActivityRemainsInBackground() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val graph = (context.applicationContext as HapiApp).appGraph
        fun shell(command: String) {
            instrumentation.uiAutomation.executeShellCommand(command).use {
                ParcelFileDescriptor.AutoCloseInputStream(it).readBytes()
            }
        }
        if (Build.VERSION.SDK_INT >= 33) shell("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
        graph.awaitReady()
        val oldHub = graph.hubRegistry.activeHubUrl
        val wasEnabled = graph.localNotifications.enabled.value
        val sendCompletion = AtomicBoolean(false)
        val sessionId = "background-${System.nanoTime()}"
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path?.startsWith("/api/events?") == true) {
                    val handshake = "data: {\"type\":\"connection-changed\",\"data\":{\"status\":\"connected\",\"subscriptionId\":\"test\",\"resume\":\"ok\"}}\n\n"
                    val completion = if (sendCompletion.get())
                        "id: test:1\ndata: {\"type\":\"message-received\",\"sessionId\":\"$sessionId\",\"message\":{\"id\":\"done\",\"createdAt\":1,\"content\":{\"type\":\"event\",\"data\":{\"type\":\"ready\"}}}}\n\n"
                    else ""
                    // EOF deliberately exercises background reconnect, without
                    // bringing the activity back or manually restarting SSE.
                    return MockResponse().setHeader("Content-Type", "text/event-stream")
                        .setBody(handshake + completion).setBodyDelay(200, TimeUnit.MILLISECONDS)
                }
                val body = when (request.path?.substringBefore('?')) {
                    "/api/sessions" -> "{\"sessions\":[]}"
                    "/api/machines" -> "{\"machines\":[]}"
                    else -> "{}"
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
        val hub = server.url("/").toString().trimEnd('/')
        val claims = Base64.encodeToString("{\"exp\":4102444800}".toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        var scenario: ActivityScenario<MainActivity>? = null
        val manager = context.getSystemService(NotificationManager::class.java)
        suspend fun awaitState(description: String, condition: () -> Boolean) {
            try {
                withTimeout(20_000) { while (!condition()) delay(100) }
            } catch (error: TimeoutCancellationException) {
                throw AssertionError("Waiting for $description: foreground=${graph.foreground}, " +
                    "enabled=${graph.localNotifications.enabled.value}, status=${graph.localNotifications.status.value}, " +
                    "hub=${graph.activeHubGraph.value?.hubUrl}, notifications=${manager.activeNotifications.size}", error)
            }
        }
        try {
            graph.credentialStore.set(HubCredentials(hub, "test-only", "e30.$claims.signature", System.currentTimeMillis()))
            graph.hubRegistry.addHub(hub)
            graph.localNotifications.setEnabled(true)
            scenario = ActivityScenario.launch(MainActivity::class.java)
            awaitState("service start on activity resume") {
                manager.activeNotifications.any { it.notification.channelId == "local_notification_connection" }
            }
            // Keep the same chat marked open: background must override
            // suppress-when-reading even though navigation still retains it.
            graph.openChatSessionId.value = sessionId
            shell("input keyevent KEYCODE_HOME")
            awaitState("process background after Home") { !graph.foreground }
            sendCompletion.set(true)
            awaitState("completion notification while backgrounded") {
                manager.activeNotifications.any {
                    it.notification.extras.getString(PushNotifications.EXTRA_SESSION_ID) == sessionId
                }
            }
            assertFalse("Notification must arrive before returning to the app", graph.foreground)
            val delivered = manager.activeNotifications.single {
                it.notification.extras.getString(PushNotifications.EXTRA_SESSION_ID) == sessionId
            }
            assertEquals(hub, delivered.notification.extras.getString(PushNotifications.EXTRA_HUB_URL))
            assertTrue(delivered.notification.actions.isNullOrEmpty())
        } finally {
            LocalNotificationService.stop(context)
            graph.openChatSessionId.value = null
            scenario?.close()
            manager.activeNotifications.filter {
                it.notification.extras.getString(PushNotifications.EXTRA_SESSION_ID) == sessionId
            }.forEach { manager.cancel(it.tag, it.id) }
            graph.hubRegistry.removeHub(hub)
            graph.credentialStore.delete(hub)
            if (oldHub != null) graph.hubRegistry.setActiveHub(oldHub)
            withTimeout(5_000) { while (graph.activeHubGraph.value?.hubUrl == hub) delay(100) }
            graph.localNotifications.setEnabled(wasEnabled)
            server.shutdown()
        }
    }
}
