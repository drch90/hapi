package app.hapi.companion.notifications

import android.app.NotificationManager
import android.content.Context
import app.hapi.companion.R
import app.hapi.companion.di.AppGraph
import app.hapi.companion.di.HubGraph
import app.hapi.companion.di.localizedForAppLanguage
import app.hapi.companion.fcm.PushNotifications
import app.hapi.data.push.*
import app.hapi.data.sse.EngineEvent
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.protocol.wire.SessionSummary
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onSubscription

/** One receiver per active hub; service cancellation releases only its background lease. */
internal class LocalNotificationReceiver(
    private val context: Context,
    private val graph: AppGraph,
    private val hub: HubGraph,
) {
    private val ledger = graph.localNotifications.ledger(hub.hubUrl)
    private val pendingCache = mutableMapOf<String, Pair<Long, List<LocalPendingRequest>>>()
    private var verified = false

    private fun current(): Boolean = graph.localNotifications.enabled.value && graph.activeHubGraph.value === hub
    private fun suppressed(sessionId: String): Boolean = shouldSuppressPush(graph.foreground, graph.openChatSessionId.value, sessionId)
    private fun name(session: SessionSummary?): String? = session?.metadata?.name
        ?: session?.metadata?.path?.substringAfterLast('/')?.takeIf { it.isNotBlank() }

    suspend fun run(): Unit = coroutineScope {
        val reconcile = Channel<Unit>(Channel.CONFLATED)
        var refresh = true
        launch {
            hub.sessionStore.sessions.map { sessions ->
                sessions.map { listOf(it.id, it.active, it.agentStateVersion, it.pendingRequestsCount, it.pendingRequests) }
            }.distinctUntilChanged().collect { reconcile.trySend(Unit) }
        }
        launch {
            var retryDelay = 1000L
            for (ignored in reconcile) {
                delay(500) // coalesce bursts of permission state updates
                try {
                    hub.sseEngine.connectionState(SseSubscriptionKey.Global).first {
                        it.phase == app.hapi.data.sse.ConnectionState.Phase.Connected
                    }
                    if (refresh) {
                        refresh = false
                        hub.sessionStore.refresh()
                        verified = true
                    }
                    if (verified) reconcilePending()
                    retryDelay = 1000
                } catch (cancel: CancellationException) {
                    throw cancel
                } catch (_: Exception) {
                    if (!verified) refresh = true
                    delay(retryDelay)
                    retryDelay = (retryDelay * 2).coerceAtMost(30_000)
                    reconcile.trySend(Unit)
                }
            }
        }
        try {
            hub.sseEngine.events(SseSubscriptionKey.Global)
                .onSubscription { hub.sseEngine.setBackgroundReceptionEnabled(true) }
                .collect { event ->
                    if (!current()) return@collect
                    when (event) {
                        is EngineEvent.Handshake -> {
                            if (event.resume == EngineEvent.Resume.Gap) {
                                refresh = true
                                pendingCache.clear()
                            }
                            reconcile.trySend(Unit)
                        }
                        is EngineEvent.Sync -> {
                            val completion = LocalNotificationPolicy.completion(event) ?: return@collect
                            val fresh = ledger.completion(completion.sessionId, completion.key)
                            graph.localNotifications.saveLedger(hub.hubUrl, ledger)
                            if (!fresh) return@collect
                            if (suppressed(completion.sessionId)) return@collect
                            val session = hub.sessionStore.sessions.value.firstOrNull { it.id == completion.sessionId }
                            val type = if (completion.task) PushType.TASK_NOTIFICATION else PushType.READY
                            show(type, completion.sessionId, name(session), completion.body)
                        }
                    }
                }
        } finally {
            hub.sseEngine.setBackgroundReceptionEnabled(false)
            graph.localNotifications.saveLedger(hub.hubUrl, ledger)
            reconcile.close()
        }
    }

    private suspend fun reconcilePending() {
        val sessions = hub.sessionStore.sessions.value
        val relevant = sessions.filter { it.active && it.pendingRequestsCount > 0 }
        val aliveTags = mutableSetOf<String>()
        var retryNeeded = false
        for (summary in relevant) {
            currentCoroutineContext().ensureActive()
            val cached = pendingCache[summary.id]
            val requests = try { if (cached != null && cached.first == summary.agentStateVersion) cached.second else {
                val detail = hub.session.api.getSession(summary.id).session
                // Reject responses older than the event that triggered the fetch.
                if (detail.agentStateVersion < summary.agentStateVersion) throw IllegalStateException("Stale notification detail")
                val latest = hub.sessionStore.sessions.value.firstOrNull { it.id == summary.id }
                if (latest == null || !latest.active) {
                    pendingCache.remove(summary.id)
                    continue
                }
                if (detail.agentStateVersion < latest.agentStateVersion) {
                    throw IllegalStateException("Notification state changed during fetch")
                }
                val list = if (!detail.active) emptyList() else detail.agentState?.requests.orEmpty()
                    .map { (id, request) -> LocalNotificationPolicy.pending(id, request) }
                pendingCache[summary.id] = detail.agentStateVersion to list
                list
            } } catch (cancel: CancellationException) {
                throw cancel
            } catch (_: Exception) {
                retryNeeded = true
                // An unavailable detail is not proof that its requests resolved.
                for (type in listOf(PushType.INPUT_REQUEST, PushType.PERMISSION_REQUEST)) {
                    aliveTags += PushNotifications.notificationTag(payload(type, summary.id, null, null), hub.hubUrl)
                }
                continue
            }
            for ((input, members) in requests.groupBy { it.input }) {
                val type = if (input) PushType.INPUT_REQUEST else PushType.PERMISSION_REQUEST
                val payload = payload(type, summary.id, name(summary), members.firstOrNull()?.preview)
                val tag = PushNotifications.notificationTag(payload, hub.hubUrl)
                aliveTags += tag
                val fresh = members.map { ledger.claim("request:${summary.id}:${it.id}") }.any { it }
                if (current() && !suppressed(summary.id)) {
                    // Existing notifications can update quietly as requests resolve;
                    // dismissed/previously seen requests are never re-created.
                    if (fresh || activeTags().contains(tag)) show(type, summary.id, name(summary), members.firstOrNull()?.preview, !fresh)
                }
            }
        }
        pendingCache.keys.retainAll(relevant.map { it.id }.toSet())
        graph.localNotifications.saveLedger(hub.hubUrl, ledger)
        if (!current()) return
        context.getSystemService(NotificationManager::class.java).activeNotifications.forEach { notification ->
            val extras = notification.notification.extras
            if (extras.getString(PushNotifications.EXTRA_HUB_URL) != hub.hubUrl) return@forEach
            val type = extras.getString(PushNotifications.EXTRA_NOTICE_TYPE)
            if (type in setOf(PushType.PERMISSION_REQUEST.wire, PushType.INPUT_REQUEST.wire) && notification.tag !in aliveTags) {
                PushNotifications.cancel(context, notification.tag)
            }
        }
        if (retryNeeded) throw IllegalStateException("Pending notification details unavailable")
    }

    private fun activeTags(): Set<String> = context.getSystemService(NotificationManager::class.java)
        .activeNotifications.mapNotNull { it.tag }.toSet()

    private fun payload(type: PushType, sessionId: String, sessionName: String?, body: String?): PushPayload {
        val localized = context.localizedForAppLanguage(graph.appLanguage.value)
        val title = localized.getString(when (type) {
            PushType.READY, PushType.TASK_NOTIFICATION -> R.string.local_notifications_ready
            PushType.PERMISSION_REQUEST -> R.string.local_notifications_approval
            PushType.INPUT_REQUEST -> R.string.local_notifications_question
        })
        return PushPayload(type, type.wire, sessionId, sessionName, null, title,
            body?.let(LocalNotificationPolicy::preview) ?: localized.getString(R.string.local_notifications_view_session),
            null, PushSeverity.INFO, null, null)
    }

    private fun show(type: PushType, sessionId: String, sessionName: String?, body: String?, quiet: Boolean = false) {
        if (!current() || !LocalNotificationService.canNotify(context)) return
        PushNotifications.show(context.localizedForAppLanguage(graph.appLanguage.value),
            payload(type, sessionId, sessionName, body), sourceHub = hub.hubUrl, allowActions = false, onlyAlertOnce = quiet)
    }
}
