package app.hapi.companion.feature.sessions

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.WorktreeMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SessionGroupsTest {
    @get:Rule val compose = createComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun progressAndActivePrecedeCollapsibleWorkspaceHistory() {
        fun row(id: String, active: Boolean = false, thinking: Boolean = false) = SessionRowUi(
            SessionSummary(id, active, thinking, metadata = SessionSummaryMetadata(path = "/repo/app")),
            title = id, subtitle = null, meta = null, flavor = null, unread = false,
        )
        val rows = listOf(row("History"), row("Connected", active = true), row("Working", active = true, thinking = true))
        val collapsed = mutableStateOf<Map<String, Boolean>>(emptyMap())
        val opened = mutableListOf<String>()
        val held = mutableListOf<String>()
        compose.setContent {
            HapiTheme {
                val sections = buildSessionSections(rows, collapsed.value)
                SessionRows(sections, searching = false,
                    onToggleSection = { id -> collapsed.value += id to !sections.single { it.id == id }.collapsed },
                    onOpen = { opened += it }, onLongPress = { held += it.id })
            }
        }
        val progress = compose.onNodeWithText(context.getString(R.string.sessions_section_in_progress)).getUnclippedBoundsInRoot()
        val active = compose.onNodeWithText(context.getString(R.string.sessions_section_active)).getUnclippedBoundsInRoot()
        val workspace = compose.onNodeWithText("repo/app").getUnclippedBoundsInRoot()
        assertTrue(progress.top < active.top && active.top < workspace.top)
        compose.onNodeWithText("History").assertDoesNotExist()
        compose.onNodeWithText("repo/app").performClick()
        compose.onNodeWithText("History").assertIsDisplayed().performTouchInput { longClick() }
        compose.runOnIdle { assertEquals(listOf("History"), held); assertTrue(opened.isEmpty()) }
        compose.onNodeWithText("History").performClick()
        compose.runOnIdle { assertEquals(listOf("History"), opened) }
        compose.onNodeWithText("repo/app").performClick()
        compose.onNodeWithText("History").assertDoesNotExist()
    }

    @Test fun workspaceCreationKeepsItsMachineAndBasePathAcrossCollapseAndSearch() {
        val row = SessionRowUi(
            SessionSummary("History", active = false, metadata = SessionSummaryMetadata(
                machineId = "machine-a", path = "/tmp/feature",
                worktree = WorktreeMetadata(basePath = "/repo/app", worktreePath = "/tmp/feature",
                    name = "feature", branch = "feature"),
            )),
            title = "History", subtitle = null, meta = null, flavor = null, unread = false,
        )
        val collapsed = mutableStateOf<Map<String, Boolean>>(emptyMap())
        val searching = mutableStateOf(false)
        val created = mutableListOf<Pair<String?, String>>()
        val opened = mutableListOf<String>()
        var toggles = 0
        compose.setContent {
            HapiTheme {
                Box(Modifier.width(320.dp)) {
                    val sections = buildSessionSections(listOf(row), collapsed.value, searching.value)
                    SessionRows(sections, searching = searching.value,
                        onToggleSection = { id ->
                            toggles++
                            collapsed.value += id to !sections.single { it.id == id }.collapsed
                        },
                        onOpen = { opened += it }, onLongPress = {},
                        onNewInDirectory = { machine, directory -> created += machine to directory })
                }
            }
        }
        val create = compose.onNodeWithContentDescription(context.getString(R.string.sessions_new_in_workspace, "repo/app"))
        compose.onNodeWithText("History").assertDoesNotExist()
        create.assertIsDisplayed().assertIsEnabled().performTouchInput { click() }
        compose.onNodeWithText("History").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, toggles) }

        compose.onNodeWithText("repo/app").performClick()
        compose.onNodeWithText("History").assertIsDisplayed()
        create.performTouchInput { click() }
        compose.onNodeWithText("History").assertIsDisplayed()

        compose.runOnIdle { searching.value = true }
        compose.onNodeWithText("repo/app").assertIsNotEnabled()
        create.assertIsEnabled().performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(List(3) { "machine-a" to "/repo/app" }, created)
            assertEquals(1, toggles)
            assertTrue(opened.isEmpty())
        }
    }

    @Test fun sameDirectoryOnDifferentMachinesHasSeparateCreationActions() {
        fun row(id: String, metadata: SessionSummaryMetadata?) = SessionRowUi(
            SessionSummary(id, active = false, metadata = metadata),
            title = id, subtitle = null, meta = null, flavor = null, unread = false,
        )
        val sections = buildSessionSections(listOf(
            row("first", SessionSummaryMetadata(path = "/repo/app", machineId = "machine-a")),
            row("second", SessionSummaryMetadata(path = "/repo/app", machineId = "machine-b")),
            row("unknown", null),
        ))
        val created = mutableListOf<Pair<String?, String>>()
        val canNavigate = mutableStateOf(true)
        compose.setContent {
            HapiTheme {
                SessionRows(sections, searching = false, onToggleSection = {}, onOpen = {}, onLongPress = {},
                    onNewInDirectory = if (canNavigate.value) { machine, directory -> created += machine to directory } else null)
            }
        }
        val createLabel = context.getString(R.string.sessions_new_in_workspace, "repo/app")
        compose.onAllNodesWithContentDescription(createLabel).assertCountEquals(2)
        compose.onAllNodesWithContentDescription(createLabel).onFirst().performClick()
        compose.onAllNodesWithContentDescription(createLabel).onLast().performClick()
        compose.onNodeWithContentDescription(context.getString(R.string.sessions_new_in_workspace,
            context.getString(R.string.sessions_section_other_workspace))).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf("machine-a" to "/repo/app", "machine-b" to "/repo/app"), created)
            canNavigate.value = false
        }
        compose.onAllNodesWithContentDescription(createLabel).assertCountEquals(0)
    }
}
