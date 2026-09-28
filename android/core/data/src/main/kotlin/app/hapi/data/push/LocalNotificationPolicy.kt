package app.hapi.data.push

import app.hapi.data.sse.EngineEvent
import app.hapi.protocol.wire.AgentStateRequest
import app.hapi.protocol.wire.SyncEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Notification recognition is independent of Android, Firebase and chat rendering. */
data class LocalCompletion(val sessionId: String, val key: String, val body: String?, val task: Boolean = false)
data class LocalPendingRequest(val id: String, val input: Boolean, val preview: String?)

object LocalNotificationPolicy {
    fun completion(event: EngineEvent.Sync): LocalCompletion? {
        val sync = event.event
        if (sync is SyncEvent.SessionEnded) {
            if (sync.reason != "completed") return null
            // Without an event id we cannot safely deduplicate a lifecycle event.
            val id = event.eventId ?: return null
            return LocalCompletion(sync.sessionId, "ended:$id", null)
        }
        if (sync !is SyncEvent.MessageReceived) return null
        val message = sync.message.content as? JsonObject ?: return null
        val wrapped = message["content"] as? JsonObject
        for (candidate in listOfNotNull(wrapped, message)) {
            val data = candidate["data"] as? JsonObject
            if (candidate.string("type") == "event" && data?.string("type") == "ready") {
                return LocalCompletion(sync.sessionId, "message:${sync.message.id}", null)
            }
            if (candidate.string("type") != "output" || data == null) continue
            if (data.string("type") == "system" && data.string("subtype") == "task_notification") {
                val status = data.string("status")
                if (status != null && status != "completed") continue
                val summary = data.string("summary")?.trim()?.takeIf { it.isNotEmpty() } ?: continue
                return LocalCompletion(sync.sessionId, "message:${sync.message.id}", preview(summary), true)
            }
            if (data.string("type") == "user") {
                val text = data.string("content") ?: (data["message"] as? JsonObject)?.string("content") ?: continue
                if (!text.trimStart().startsWith("<task-notification>")) continue
                val status = Regex("<status>([\\s\\S]*?)</status>").find(text)?.groupValues?.get(1)?.trim()
                if (status != null && status != "completed") continue
                val summary = Regex("<summary>([\\s\\S]*?)</summary>").find(text)?.groupValues?.get(1)?.trim()
                    ?.takeIf { it.isNotEmpty() } ?: continue
                return LocalCompletion(sync.sessionId, "message:${sync.message.id}", preview(summary), true)
            }
        }
        return null
    }

    fun pending(id: String, request: AgentStateRequest): LocalPendingRequest {
        val tool = request.tool.removePrefix("functions.")
        val input = tool in setOf("request_user_input", "AskUserQuestion", "ask_user_question", "CursorAskQuestion")
        val args = request.arguments as? JsonObject
        val question = ((args?.get("questions") as? JsonArray)?.firstOrNull() as? JsonObject)?.string("question")
        return LocalPendingRequest(id, input, if (input) question?.let(::preview) else preview(request.tool))
    }

    fun preview(text: String): String = text.replace(Regex("\\s+"), " ").trim().take(280)

    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
}

/** Bounded persistent dedup, per hub at the caller. No message content is stored. */
class LocalNotificationLedger(
    initial: Map<String, Long> = emptyMap(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val entries = initial.toMutableMap()

    fun claim(key: String): Boolean {
        prune()
        if (key in entries) return false
        entries[key] = now()
        prune()
        return true
    }

    fun completion(sessionId: String, eventKey: String): Boolean {
        if (!claim("event:$sessionId:$eventKey")) return false
        val cooldown = "cooldown:$sessionId"
        val previous = entries[cooldown]
        if (previous != null && now() - previous in 0L until 5_000L) return false
        entries[cooldown] = now()
        prune()
        return true
    }

    fun snapshot(): Map<String, Long> { prune(); return entries.toMap() }

    private fun prune() {
        val cutoff = now() - 7L * 24 * 60 * 60 * 1000
        entries.entries.removeAll { it.value < cutoff || it.value > now() }
        if (entries.size > 2048) {
            entries.entries.sortedBy { it.value }.take(entries.size - 2048).forEach { entries.remove(it.key) }
        }
    }
}
