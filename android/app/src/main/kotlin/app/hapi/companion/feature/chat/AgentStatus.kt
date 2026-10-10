package app.hapi.companion.feature.chat

import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionSummary

sealed interface AgentStatusUi {
    data object Offline : AgentStatusUi
    data object PermissionRequired : AgentStatusUi
    data object Thinking : AgentStatusUi
    data class BackgroundTasks(val count: Int) : AgentStatusUi
    data object Online : AgentStatusUi
}

/** Web StatusBar priority; summaries cover the period before full detail arrives. */
internal fun deriveAgentStatus(detail: Session?, summary: SessionSummary?): AgentStatusUi {
    val active = detail?.active ?: summary?.active ?: false
    if (!active) return AgentStatusUi.Offline

    val hasRequests = if (detail != null) !detail.agentState?.requests.isNullOrEmpty()
        else (summary?.pendingRequestsCount ?: 0) > 0
    if (hasRequests) return AgentStatusUi.PermissionRequired
    if (detail?.thinking ?: summary?.thinking ?: false) return AgentStatusUi.Thinking

    val backgroundTasks = if (detail != null) detail.backgroundTaskCount ?: 0
        else summary?.backgroundTaskCount ?: 0
    return if (backgroundTasks > 0) AgentStatusUi.BackgroundTasks(backgroundTasks) else AgentStatusUi.Online
}
