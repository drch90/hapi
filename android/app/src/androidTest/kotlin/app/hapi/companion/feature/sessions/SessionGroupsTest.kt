package app.hapi.companion.feature.sessions

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
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
}
