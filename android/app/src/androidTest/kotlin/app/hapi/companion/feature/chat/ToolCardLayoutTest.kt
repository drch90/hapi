package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.hapi.companion.feature.chat.blocks.ToolCallBlockView
import app.hapi.companion.feature.chat.blocks.previewToolCall
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.chat.ToolState
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ToolCardLayoutTest {
    @get:Rule val compose = createComposeRule()

    private fun command(id: String, result: String) = previewToolCall(
        id, "Bash", input = mapOf("command" to "printf 'nested task'"),
    ).also {
        it.tool = it.tool.copy(startedAt = 1_000.0, completedAt = 65_000.0, result = JsonPrimitive(result))
    }

    private fun waitForText(text: String) {
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(text, substring = true).assertIsDisplayed()
    }

    @Test fun compactCardShowsStatusAndDurationThenOneTapRevealsFullTiming() {
        val block = command("command", "Command result")
        val opened = mutableStateOf(false)
        val fontScale = mutableStateOf(1f)
        val inspection = object : ChatInspectionActions {
            override fun openTool(id: String) { assertEquals(block.id, id); opened.value = true }
            override fun openGroup(id: String) = Unit
            override fun openMessage(id: String) = Unit
        }
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(
                    LocalDensity provides Density(LocalDensity.current.density, fontScale.value),
                    LocalChatInspection provides inspection,
                ) {
                    Box(Modifier.width(320.dp)) {
                        if (opened.value) ToolReader(Inspected(block, false), false, "/repo", { _, _ -> }, {}, {})
                        else ToolCallBlockView(block, "/repo", Modifier.testTag("compact-card"))
                    }
                }
            }
        }
        compose.onNodeWithTag("tool-timing-summary-command", useUnmergedTree = true).assertTextEquals("Done · 1:04")
        compose.onNodeWithTag("tool-timing-details-command").assertDoesNotExist()
        val compact = compose.onNodeWithTag("compact-card").getUnclippedBoundsInRoot()
        assertTrue("A collapsed command should occupy at most two compact lines", compact.height <= 80.dp)
        compose.runOnIdle { fontScale.value = 2f }
        val card = compose.onNodeWithTag("compact-card").getUnclippedBoundsInRoot()
        val status = compose.onNodeWithTag("tool-timing-summary-command", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue(status.left >= card.left && status.right <= card.right)
        compose.runOnIdle { fontScale.value = 1f }
        compose.onNodeWithTag("compact-card").performTouchInput { click(center) }
        compose.onNodeWithTag("tool-timing-details-command").assertIsDisplayed()
        compose.onNodeWithText("Start:", substring = true).assertIsDisplayed()
        compose.onNodeWithText("End:", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Total: 1:04").assertIsDisplayed()
        waitForText("Command result")
    }

    @Test fun openingAnAgentProcessShowsNestedCommandOutputWithoutAnotherExpansion() {
        fun process(result: String): ToolCallBlock {
            val nested = previewToolCall("nested-agent", "Task", input = mapOf("description" to "Nested worker"))
            nested.children = listOf(command("nested-command", result))
            return previewToolCall("agent", "Task", input = mapOf("description" to "Inspect the repository")).also {
                it.tool = it.tool.copy(startedAt = 1_000.0, completedAt = 65_000.0)
                it.children = listOf(nested)
            }
        }
        val block = mutableStateOf(process("Nested stdout before update"))
        val opened = mutableStateOf(false)
        val inspection = object : ChatInspectionActions {
            override fun openTool(id: String) { assertEquals("agent", id); opened.value = true }
            override fun openGroup(id: String) = Unit
            override fun openMessage(id: String) = Unit
        }
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(LocalChatInspection provides inspection) {
                    if (opened.value) ToolReader(Inspected(block.value, false), true, "/repo", { _, _ -> }, {}, {})
                    else ToolCallBlockView(block.value, "/repo", Modifier.testTag("agent-card"))
                }
            }
        }
        compose.onNodeWithTag("tool-timing-summary-agent", useUnmergedTree = true).assertTextEquals("Done · 1:04")
        assertTrue(compose.onNodeWithTag("agent-card").getUnclippedBoundsInRoot().height <= 80.dp)
        compose.onNodeWithText("Nested stdout before update").assertDoesNotExist()
        compose.onNodeWithTag("agent-card").performTouchInput { click(center) }
        // Notice, parent agent, nested agent, then the nested command. All
        // bodies are already expanded in one lazy list with stable call IDs.
        compose.onNodeWithTag("inspection-detail").performScrollToIndex(3)
        compose.onNodeWithTag("tool-timing-details-nested-command").assertIsDisplayed()
        waitForText("Nested stdout before update")
        compose.onNodeWithTag("inspection-tool-nested-command").assert(hasClickAction().not())
        compose.runOnIdle { block.value = process("Nested stdout after update") }
        waitForText("Nested stdout after update")
        compose.onNodeWithText("Nested stdout before update").assertDoesNotExist()
    }

    @Test fun expandedPermissionActionsAreAvailableOnlyForLiveInspection() {
        val tool = previewToolCall("approval", "Bash", state = ToolState.RUNNING, input = mapOf("command" to "pwd"),
            permission = ToolPermission("request", "pending", presence = setOf("id", "status")))
        tool.tool = tool.tool.copy(createdAt = System.currentTimeMillis(), startedAt = System.currentTimeMillis().toDouble())
        val inspected = mutableStateOf(Inspected(tool, true))
        var decisions = 0
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(LocalChatInteractions provides ChatInteractions("claude", emptyMap(), { _, _ -> decisions++ }, {})) {
                    ToolReader(inspected.value, false, "/repo", { _, _ -> }, {}, {})
                }
            }
        }
        compose.onNodeWithText("Allow").assertDoesNotExist()
        compose.runOnIdle { inspected.value = Inspected(tool, false) }
        compose.onNodeWithText("Allow").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, decisions) }
    }
}
