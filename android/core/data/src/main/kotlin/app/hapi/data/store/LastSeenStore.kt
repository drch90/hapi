package app.hapi.data.store

import app.hapi.protocol.wire.SessionSummary
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/** Snapshot payload: watermarks + which scopes already got their baseline. */
@Serializable
data class LastSeenState(
    val lastSeen: Map<String, Long> = emptyMap(),
    val baselines: Set<String> = emptySet(),
    val manualUnread: Map<String, Long> = emptyMap(),
    val machineFilter: String? = null,
    val activeOnly: Boolean = false,
)

/**
 * Per-session last-seen watermarks — port of `web/src/lib/sessionLastSeen.ts`
 * (localStorage → per-hub JSON snapshot) plus the unread derivation from
 * `web/src/lib/sessionAttention.ts`.
 *
 * The watermark is the session `updatedAt` the operator last had on screen;
 * a session is **unread** when its current `updatedAt` moved past it
 * ([isUnread] — the reference compares `updatedAt` only; message `seq` never
 * reaches the summary). [initializeBaseline] seeds missing watermarks from
 * the first session list so a fresh install does not mark every historical
 * session unread — once per [LastSeenState.baselines] scope, exactly like the
 * web's per-scope baseline flag.
 */
class LastSeenStore(
    scope: CoroutineScope,
    snapshotDir: File? = null,
) {
    private val snapshot: JsonSnapshotStore<LastSeenState>? = snapshotDir?.let { dir ->
        JsonSnapshotStore(
            file = File(dir, "last-seen.json"),
            serializer = LastSeenState.serializer(),
            scope = scope,
        )
    }

    private val _state = MutableStateFlow(snapshot?.load() ?: LastSeenState())
    val state: StateFlow<LastSeenState> = _state.asStateFlow()

    fun lastSeenAt(sessionId: String): Long = _state.value.lastSeen[sessionId] ?: 0

    /** Forces the debounced snapshot to disk (app background / tests). */
    suspend fun flushPersistence() {
        snapshot?.flush()
    }

    /** `markSessionSeen`: monotonic max — a stale screen never rewinds the watermark. */
    fun markSeen(sessionId: String, seenAt: Long) {
        if (sessionId.isEmpty()) return
        updateState { state ->
            val current = state.lastSeen[sessionId] ?: 0
            val next = maxOf(current, seenAt)
            val manual = state.manualUnread[sessionId]
            if (next == current && state.lastSeen.containsKey(sessionId) && manual == null) state
            else state.copy(lastSeen = state.lastSeen + (sessionId to next),
                manualUnread = if (manual != null && next >= manual) state.manualUnread - sessionId else state.manualUnread)
        }
    }

    fun setListPreferences(machineFilter: String?, activeOnly: Boolean) {
        updateState { it.copy(machineFilter = machineFilter, activeOnly = activeOnly) }
    }

    fun markUnread(sessionId: String, updatedAt: Long) {
        updateState { state -> state.copy(
            lastSeen = state.lastSeen + (sessionId to minOf(state.lastSeen[sessionId] ?: updatedAt, updatedAt - 1)),
            manualUnread = state.manualUnread + (sessionId to updatedAt),
        ) }
    }

    fun markAllSeen(sessions: Iterable<SessionSummary>) {
        updateState { state ->
            val seen = state.lastSeen.toMutableMap()
            val manual = state.manualUnread.toMutableMap()
            sessions.forEach { session ->
                seen[session.id] = maxOf(seen[session.id] ?: 0, session.updatedAt)
                manual.remove(session.id)
            }
            state.copy(lastSeen = seen, manualUnread = manual)
        }
    }

    /**
     * `initializeSessionLastSeen`: on the first list load for [scopeKey]
     * (e.g. the hub id), seed every session without a watermark at its
     * current `updatedAt`, then never again for that scope.
     */
    fun initializeBaseline(scopeKey: String, sessions: Iterable<SessionSummary>) {
        updateState { state ->
            if (scopeKey in state.baselines) return@updateState state
            val seeded = state.lastSeen.toMutableMap()
            for (session in sessions) {
                seeded.getOrPut(session.id) { session.updatedAt }
            }
            state.copy(lastSeen = seeded, baselines = state.baselines + scopeKey)
        }
    }

    private inline fun updateState(transform: (LastSeenState) -> LastSeenState) {
        while (true) {
            val previous = _state.value
            val next = transform(previous)
            if (next === previous) return
            if (_state.compareAndSet(previous, next)) {
                snapshot?.scheduleWrite(next)
                return
            }
        }
    }

    companion object {
        /** `sessionIsUnread`: activity newer than the operator's watermark. */
        fun isUnread(summary: SessionSummary, lastSeenAt: Long): Boolean =
            summary.updatedAt > lastSeenAt
    }
}
