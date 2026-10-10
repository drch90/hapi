package app.hapi.companion.feature.chat

import app.hapi.protocol.wire.AgentState
import app.hapi.protocol.wire.AgentStateRequest
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionSummary
import kotlin.test.Test
import kotlin.test.assertEquals

class AgentStatusTest {
    private fun detail(active: Boolean = true, thinking: Boolean = false, backgroundTasks: Int? = null) = Session(
        id = "session", namespace = "default", seq = 1, createdAt = 1, updatedAt = 1,
        active = active, metadataVersion = 1, agentStateVersion = 1,
        thinking = thinking, thinkingAt = 1, backgroundTaskCount = backgroundTasks,
    )

    @Test fun `offline overrides stale requests thinking and background work`() {
        val summary = SessionSummary("session", active = false, thinking = true,
            pendingRequestsCount = 1, backgroundTaskCount = 3)
        val session = detail(active = false, thinking = true, backgroundTasks = 3)
            .copy(agentState = AgentState(requests = mapOf("permission" to AgentStateRequest("Bash"))))
        assertEquals(AgentStatusUi.Offline, deriveAgentStatus(null, null))
        assertEquals(AgentStatusUi.Offline, deriveAgentStatus(null, summary))
        assertEquals(AgentStatusUi.Offline, deriveAgentStatus(session, summary.copy(active = true)))
    }

    @Test fun `permission and input requests take priority over running work`() {
        for (tool in listOf("Bash", "request_user_input")) {
            val session = detail(thinking = true, backgroundTasks = 3)
                .copy(agentState = AgentState(requests = mapOf("request" to AgentStateRequest(tool))))
            assertEquals(AgentStatusUi.PermissionRequired, deriveAgentStatus(session, null))
        }
    }

    @Test fun `thinking and background work settle back to online`() {
        assertEquals(AgentStatusUi.Thinking, deriveAgentStatus(detail(thinking = true, backgroundTasks = 2), null))
        assertEquals(AgentStatusUi.BackgroundTasks(2), deriveAgentStatus(detail(backgroundTasks = 2), null))
        assertEquals(AgentStatusUi.BackgroundTasks(1), deriveAgentStatus(detail(backgroundTasks = 1), null))
        assertEquals(AgentStatusUi.Online, deriveAgentStatus(detail(backgroundTasks = 0), null))
        assertEquals(AgentStatusUi.Online, deriveAgentStatus(detail(), null))
    }

    @Test fun `summaries provide live status before the detail is available`() {
        val summary = SessionSummary("session", active = true)
        assertEquals(AgentStatusUi.Online, deriveAgentStatus(null, summary))
        assertEquals(AgentStatusUi.BackgroundTasks(2), deriveAgentStatus(null, summary.copy(backgroundTaskCount = 2)))
        assertEquals(AgentStatusUi.Thinking, deriveAgentStatus(null, summary.copy(thinking = true, backgroundTaskCount = 2)))
        assertEquals(AgentStatusUi.PermissionRequired, deriveAgentStatus(null,
            summary.copy(thinking = true, pendingRequestsCount = 1, backgroundTaskCount = 2)))
    }

    @Test fun `loaded detail clears stale summary status`() {
        val stale = SessionSummary("session", active = true, thinking = true,
            pendingRequestsCount = 1, backgroundTaskCount = 3)
        assertEquals(AgentStatusUi.Online, deriveAgentStatus(detail(), stale))
        assertEquals(AgentStatusUi.Online, deriveAgentStatus(detail().copy(agentState = AgentState(requests = emptyMap())), stale))
        assertEquals(AgentStatusUi.Thinking, deriveAgentStatus(detail(thinking = true), stale.copy(active = false)))
    }
}
