package app.hapi.protocol.session

import app.hapi.protocol.wire.*
import kotlin.test.*

class SessionReferencesTest {
    @Test fun `copy uses canonical peer citation and sanitizes the title`() {
        assertEquals("See session \"开发 \\\"A\\\"\" (/sessions/abc) for context." + SessionReferences.STEER_SUFFIX,
            SessionReferences.copyText(" 开发\n\"A\" ", "abc"))
        assertEquals("See HAPI session /sessions/abc for context." + SessionReferences.STEER_SUFFIX, SessionReferences.copyText(" ", "abc"))
    }

    @Test fun `markdown round trips escaped labels and full ids`() {
        val wire = "prefix " + SessionReferences.markdown("标题 [a] \\ b", "id+part") + " suffix"
        val mention = SessionReferences.mentions(wire).single()
        assertEquals("id+part", mention.id)
        assertEquals("标题 [a] \\ b", mention.title)
        assertEquals(7, mention.start)
        assertTrue(wire.substring(mention.start, mention.end).contains("id%2Bpart"))
    }

    @Test fun `only relative session routes are navigation targets`() {
        assertEquals("abc", SessionReferences.parsePath("/hapi/sessions/abc"))
        assertEquals("abc", SessionReferences.parsePath("./sessions/abc/"))
        for (href in listOf("https://elsewhere/sessions/abc", "//host/sessions/abc", "/sessions/file.kt", "/sessions/%ZZ", "/sessions/a%2Fb", "/etc/passwd")) {
            assertNull(SessionReferences.parsePath(href), href)
        }
    }

    @Test fun `mentions require conversation content and exclude self and empty archived shortlist`() {
        val empty = session("empty", "Named but empty", false)
        val content = session("content", "Untitled", true)
        val archived = session("old", "Archived", true).let { it.copy(metadata = it.metadata!!.copy(lifecycleState = "archived")) }
        val results = SessionDiscovery.mentionCandidates(listOf(empty, content, archived), "current", "") { "" }
        assertEquals(listOf("content"), results.map { it.id })
        assertEquals(listOf("old"), SessionDiscovery.mentionCandidates(listOf(archived), "current", "Archived") { "" }.map { it.id })
        assertTrue(SessionDiscovery.mentionCandidates(listOf(content), "content", "") { "" }.isEmpty())
    }

    @Test fun `search is AND across fields with title precedence and wildcards`() {
        val title = session("a", "Fix Login", true)
        val summary = session("b", "Other", true).let { it.copy(metadata = it.metadata!!.copy(summary = SummaryText("Fix Login"))) }
        assertTrue(SessionDiscovery.score(title, "login")!! > SessionDiscovery.score(summary, "login")!!)
        assertNotNull(SessionDiscovery.score(title, "login runner", "runner"))
        assertNull(SessionDiscovery.score(title, "login missing"))
        assertNotNull(SessionDiscovery.score(title, "l?g*n"))
    }

    @Test fun `model directory keeps provider identities separate`() {
        val parsed = HapiJson.decodeFromString(AgentModelDirectory.serializer(), """{"success":true,"availableModels":[{"provider":"a","modelId":"same"},{"provider":"b","modelId":"same"}]}""")
        assertNotEquals(parsed.availableModels[0].selectionKey, parsed.availableModels[1].selectionKey)
    }

    private fun session(id: String, name: String, content: Boolean) = SessionSummary(id, active = false,
        metadata = SessionSummaryMetadata(name = name, path = "/project"), hasConversationContent = content)
}
