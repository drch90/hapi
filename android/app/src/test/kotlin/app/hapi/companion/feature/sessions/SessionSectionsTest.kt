package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.WorktreeMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionSectionsTest {
    private fun row(
        id: String,
        active: Boolean = false,
        path: String = "/repo/app",
        machineId: String? = "machine-a",
        updatedAt: Long = 0,
        edit: (SessionSummary) -> SessionSummary = { it },
    ): SessionRowUi {
        val summary = edit(SessionSummary(id = id, active = active, updatedAt = updatedAt,
            metadata = SessionSummaryMetadata(path = path, machineId = machineId)))
        return SessionRowUi(summary, id, null, null, null, unread = false)
    }

    @Test fun `progress active and workspace sections follow global pins without duplicating rows`() {
        val rows = listOf(
            row("history", updatedAt = 100),
            row("ready", active = true),
            row("thinking", active = true) { it.copy(thinking = true) },
            row("background", active = true) { it.copy(backgroundTaskCount = 2) },
            row("approval", active = true) { it.copy(pendingRequestsCount = 1) },
            row("pinned", active = true) { it.copy(globalPinned = true, thinking = true) },
            row("stale") { it.copy(thinking = true, pendingRequestsCount = 1) },
        )
        val sections = buildSessionSections(rows)
        assertEquals(listOf(SessionSectionKind.PINNED, SessionSectionKind.IN_PROGRESS,
            SessionSectionKind.ACTIVE, SessionSectionKind.WORKSPACE), sections.map { it.kind })
        assertEquals(listOf("thinking", "background", "approval"), sections[1].rows.map { it.id })
        assertEquals(listOf("ready"), sections[2].rows.map { it.id })
        assertEquals(listOf("history", "stale"), sections[3].rows.map { it.id })
        assertEquals(rows.map { it.id }.sorted(), sections.flatMap { it.rows }.map { it.id }.sorted())
        assertTrue(sections.take(3).none { it.collapsed })
        assertTrue(sections.last().collapsed)
    }

    @Test fun `worktrees share their base workspace and machine identity separates identical paths`() {
        val worktree = WorktreeMetadata(basePath = "/repo/app", worktreePath = "/tmp/feature",
            name = "feature", branch = "feature")
        val sections = buildSessionSections(listOf(
            row("base"),
            row("tree", path = "/tmp/feature") { it.copy(metadata = it.metadata!!.copy(worktree = worktree)) },
            row("other-machine", machineId = "machine-b"),
            row("same-name", path = "/other/repo/app"),
            row("unknown", machineId = null),
            row("no-metadata") { it.copy(metadata = null) },
        ))
        assertEquals(5, sections.size)
        assertEquals(5, sections.map { it.id }.toSet().size)
        val workspace = sections.single { it.rows.any { row -> row.id == "base" } }
        assertEquals(listOf("base", "tree"), workspace.rows.map { it.id })
        assertEquals("/repo/app", workspace.directory)
        assertEquals("machine-a", workspace.machineId)
        assertNull(workspace.machine)
        assertEquals("machine-b", sections.single { it.rows.singleOrNull()?.id == "other-machine" }.machineId)
        assertNull(sections.single { it.rows.singleOrNull()?.id == "unknown" }.machineId)
    }

    @Test fun `project pins lead their workspace and workspace history is ordered by recency`() {
        val sections = buildSessionSections(listOf(
            row("recent", path = "/repo/new", updatedAt = 30),
            row("history", updatedAt = 20),
            row("old", path = "/repo/old", updatedAt = 5),
            row("project-pin", active = true, updatedAt = 1) { it.copy(pinned = true) },
        ))
        assertEquals(listOf("/repo/app", "/repo/new", "/repo/old"), sections.map { it.directory })
        assertEquals(listOf("project-pin", "history"), sections.first().rows.map { it.id })
        assertFalse(sections.first().collapsed)
    }

    @Test fun `search expands groups temporarily without changing collapse preferences`() {
        val rows = listOf(row("history"), row("active", active = true))
        val initial = buildSessionSections(rows)
        val workspace = initial.single { it.kind == SessionSectionKind.WORKSPACE }
        val overrides = mapOf(workspace.id to false, "active" to true)
        val changed = buildSessionSections(rows, overrides)
        assertFalse(changed.single { it.kind == SessionSectionKind.WORKSPACE }.collapsed)
        assertTrue(changed.single { it.kind == SessionSectionKind.ACTIVE }.collapsed)
        assertTrue(buildSessionSections(rows, overrides, searching = true).none { it.collapsed })
        assertEquals(changed, buildSessionSections(rows, overrides))
    }
}
