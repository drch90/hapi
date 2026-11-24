package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.AttachedJob
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionListOrder
import app.hapi.protocol.wire.SessionListSort
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
        val summary = edit(SessionSummary(id = id, active = active, updatedAt = updatedAt, lastUserMessageAt = updatedAt,
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

    @Test fun attachedJobsOnlyPromoteUnarchivedSessionsWithRunningWork() {
        val job = AttachedJob(key = "import", label = "Import", heartbeatAt = 0, startedAt = 0, updatedAt = 0)
        val rows = listOf(
            row("running") { it.copy(attachedJob = job) },
            row("archived") {
                it.copy(attachedJob = job, metadata = it.metadata!!.copy(lifecycleState = "archived"))
            },
            row("finished") { it.copy(attachedJob = job.copy(status = "completed")) },
        )
        val sections = buildSessionSections(rows)
        assertEquals(listOf(SessionSectionKind.IN_PROGRESS, SessionSectionKind.WORKSPACE), sections.map { it.kind })
        assertEquals(listOf("running"), sections.first().rows.map { it.id })
        assertEquals(listOf("archived", "finished"), sections.last().rows.map { it.id })
        assertEquals(job, sections.last().rows.first().runningJob)
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

    @Test fun liveWorkspacesKeepCreationTargetsWithoutDuplicatingTheirSessions() {
        val rows = listOf(
            row("ready", active = true, updatedAt = 20),
            row("working", active = true, path = "/tmp/feature", updatedAt = 30) {
                it.copy(thinking = true, metadata = it.metadata!!.copy(
                    worktree = WorktreeMetadata(basePath = "/repo/app", worktreePath = "/tmp/feature",
                        name = "feature", branch = "feature"),
                ))
            },
            row("other-machine", active = true, machineId = "machine-b", updatedAt = 10),
            row("global", active = true, path = "/repo/global") { it.copy(globalPinned = true) },
            row("unknown", active = true) { it.copy(metadata = null) },
        )
        val sections = buildSessionSections(rows)
        val workspaces = sections.filter { it.kind == SessionSectionKind.WORKSPACE }
        assertEquals(listOf("machine-a" to "/repo/app", "machine-b" to "/repo/app"),
            workspaces.map { it.machineId to it.directory })
        assertTrue(workspaces.all { it.rows.isEmpty() })
        assertEquals(rows.map { it.id }.sorted(), sections.flatMap { it.rows }.map { it.id }.sorted())
        assertEquals(sections.size, sections.map { it.id }.toSet().size)
    }

    @Test fun liveWorkspaceHeadersFollowSearchRelevanceOrLatestUserInput() {
        val rows = listOf(
            row("best-match", active = true, path = "/repo/first", updatedAt = 1),
            row("recent", active = true, path = "/repo/second", updatedAt = 20) { it.copy(thinking = true) },
        )
        fun directories(searching: Boolean) = buildSessionSections(rows, searching = searching)
            .filter { it.kind == SessionSectionKind.WORKSPACE }.map { it.directory }
        assertEquals(listOf("/repo/second", "/repo/first"), directories(false))
        assertEquals(listOf("/repo/first", "/repo/second"), directories(true))
    }

    @Test fun `workspace order ignores agent output and follows the latest user input`() {
        for (active in listOf(false, true)) {
            val rows = listOf(
                row("old-prompt", active = active, path = "/repo/first", updatedAt = 99_999) { it.copy(lastUserMessageAt = 1) },
                row("new-prompt", active = active, path = "/repo/second", updatedAt = 2),
            )
            fun directories(items: List<SessionRowUi>) = buildSessionSections(items)
                .filter { it.kind == SessionSectionKind.WORKSPACE }.map { it.directory }
            assertEquals(listOf("/repo/second", "/repo/first"), directories(rows))
            val nextPrompt = rows.first().let { it.copy(summary = it.summary.copy(lastUserMessageAt = 3)) }
            assertEquals(listOf("/repo/first", "/repo/second"), directories(listOf(nextPrompt, rows.last())))
        }
    }
    @Test fun flatModeKeepsBothPinKindsAndEverySessionWithoutCollapsedGroups() {
        val rows = listOf(
            row("global") { it.copy(globalPinned = true) },
            row("project") { it.copy(pinned = true) },
            row("working", active = true) { it.copy(thinking = true) },
            row("history"),
        )
        val grouped = buildSessionSections(rows)
        val overrides = grouped.associate { it.id to true }
        val flat = buildSessionSections(rows, overrides, grouped = false)
        assertEquals(listOf(SessionSectionKind.PINNED, SessionSectionKind.RECENT), flat.map { it.kind })
        assertEquals(listOf("global", "project"), flat.first().rows.map { it.id })
        assertEquals(listOf("working", "history"), flat.last().rows.map { it.id })
        assertTrue(flat.none { it.collapsed })
        assertEquals(grouped.map { it.id }, buildSessionSections(rows, overrides).map { it.id })
        assertTrue(buildSessionSections(rows, overrides).all { it.collapsed })
    }

    @Test fun windowsPathVariantsShareAWorkspaceAndCollidingLabelsKeepParentContext() {
        val sections = buildSessionSections(listOf(
            row("windows", path = "C:\\team-a\\src\\app"),
            row("git-path", path = "C:/team-a/src/app"),
            row("other", path = "C:/team-b/src/app"),
        ))
        assertEquals(2, sections.size)
        val first = sections.single { it.directory == "C:/team-a/src/app" }
        assertEquals(listOf("windows", "git-path"), first.rows.map { it.id })
        assertEquals("team-a/src/app", first.title)
        assertEquals("team-b/src/app", sections.single { it.directory == "C:/team-b/src/app" }.title)
    }

    @Test fun disablingActiveFirstKeepsLiveRowsInTheirWorkspace() {
        val rows = listOf(row("live", active = true), row("history"))
        val sections = buildSessionSections(rows, order = SessionListOrder.Base)
        assertEquals(listOf(SessionSectionKind.WORKSPACE), sections.map { it.kind })
        assertEquals(listOf("live", "history"), sections.single().rows.map { it.id })
        assertEquals("/repo/app", sections.single().directory)
    }

    @Test fun createdOrderAlsoOrdersWorkspaceGroupsWhileKeepingProjectPins() {
        val rows = listOf(
            row("old-created-new-input", path = "/repo/a", updatedAt = 100) { it.copy(createdAt = 1) },
            row("new-created-old-input", path = "/repo/b", updatedAt = 10) { it.copy(createdAt = 50) },
            row("project-pin", path = "/repo/c", updatedAt = 1) { it.copy(pinned = true, createdAt = 0) },
        )
        val sections = buildSessionSections(rows,
            order = SessionListOrder(sort = SessionListSort.Created, activeFirst = false))
        assertEquals(listOf("/repo/c", "/repo/b", "/repo/a"), sections.map { it.directory })
        assertEquals(rows.map { it.id }.toSet(), sections.flatMap { it.rows }.map { it.id }.toSet())
    }

}
