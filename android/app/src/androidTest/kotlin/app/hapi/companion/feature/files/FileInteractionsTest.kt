package app.hapi.companion.feature.files

import android.content.ClipboardManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.*
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class FileInteractionsTest {
    @get:Rule val compose = createComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val gateway = InteractionFilesGateway()
    private val opened = mutableListOf<Pair<String, Boolean?>>()
    private val inserted = mutableListOf<String>()
    private fun label(id: Int) = context.getString(id)

    @After fun close() { scope.cancel() }

    private fun mountBrowser() {
        val model = FilesViewModel("session", gateway, scope)
        compose.setContent {
            HapiTheme {
                FilesScreen(model, onBack = {}, onOpenFile = { path, staged -> opened += path to staged },
                    rootPath = "/work/project", onSendToComposer = { inserted += it })
            }
        }
    }

    private fun copyPath() = compose.onNodeWithText(label(R.string.files_viewer_copy_path)).performClick()
    private fun insertPath() = compose.onNodeWithText(label(R.string.files_send_to_composer)).performClick()
    private fun clipboardText() = context.getSystemService(ClipboardManager::class.java)
        .primaryClip?.getItemAt(0)?.text?.toString()

    @Test fun folderAndFileLongPressOfferExactPathsWithoutOpeningOrExpanding() {
        mountBrowser()
        compose.onNodeWithContentDescription(label(R.string.files_path_actions)).performTouchInput { longClick() }
        copyPath()
        compose.runOnIdle { assertEquals("/work/project", clipboardText()) }
        compose.onNodeWithText(label(R.string.files_tab_browse)).performClick()
        compose.onNodeWithText("docs").performTouchInput { longClick() }
        compose.onNodeWithText(label(R.string.files_folder_actions)).assertIsDisplayed()
        copyPath()
        compose.onNodeWithText("guide.md").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("docs", clipboardText())
            assertTrue(opened.isEmpty())
        }
        compose.onNodeWithText("docs").performClick()
        compose.onNodeWithText("guide.md").performTouchInput { longClick() }
        insertPath()
        compose.runOnIdle {
            assertEquals(listOf("docs/guide.md"), inserted)
            assertTrue(opened.isEmpty())
        }
        compose.onNodeWithText("guide.md").performClick()
        compose.runOnIdle { assertEquals(listOf("docs/guide.md" to null), opened) }
    }

    @Test fun gitChangesAndSearchAlsoExposePathActions() {
        mountBrowser()
        compose.onNodeWithText("guide.md").performTouchInput { longClick() }
        copyPath()
        compose.runOnIdle { assertEquals("docs/guide.md", clipboardText()); assertTrue(opened.isEmpty()) }
        compose.onNodeWithText("guide.md").performClick()
        compose.runOnIdle { assertEquals(listOf("docs/guide.md" to false), opened) }
        compose.onNodeWithText(label(R.string.files_tab_search)).performClick()
        compose.onNode(hasSetTextAction()).performTextInput("guide")
        compose.waitUntil(5_000) { compose.onAllNodesWithText("docs/guide.md").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("docs/guide.md").performTouchInput { longClick() }
        insertPath()
        compose.runOnIdle { assertEquals(listOf("docs/guide.md"), inserted) }
    }

    @Test fun modifiedMarkdownStartsInPreviewAndCanSwitchToSourceAndBackOnAPhone() {
        val model = FileViewerViewModel("session", "docs/guide.md", null, null, null, gateway, scope)
        compose.setContent {
            HapiTheme {
                Box(Modifier.width(320.dp)) {
                    FileViewerScreen(model, onBack = {}, onSendToComposer = { inserted += it })
                }
            }
        }
        compose.onNodeWithText("Preview title").assertIsDisplayed()
        compose.onNodeWithText(label(R.string.files_viewer_source)).performScrollTo().performClick()
        compose.runOnIdle { assertFalse(model.state.value.markdownPreview) }
        compose.onNodeWithText("# Preview title", substring = true).assertIsDisplayed()
        compose.onNodeWithText(label(R.string.files_viewer_preview)).performScrollTo().performClick()
        compose.onNodeWithText("Preview title").assertIsDisplayed()
        compose.onNodeWithContentDescription(label(R.string.files_path_actions)).performTouchInput { longClick() }
        insertPath()
        compose.runOnIdle { assertEquals(listOf("docs/guide.md"), inserted) }
    }
}

private class InteractionFilesGateway : FilesGateway {
    override suspend fun gitStatus(sessionId: String) = GitCommandResponse(true,
        stdout = "# branch.head main\n1 .M N... 100644 100644 100644 aaaaaaaa bbbbbbbb docs/guide.md")
    override suspend fun gitDiffNumstat(sessionId: String, staged: Boolean) = GitCommandResponse(true, stdout = "")
    override suspend fun gitDiffFile(sessionId: String, path: String, staged: Boolean?) = GitCommandResponse(true,
        stdout = "diff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-old\n+# Preview title\n")
    override suspend fun readFile(sessionId: String, path: String) = FileReadResponse(true,
        content = Base64.getEncoder().encodeToString("# Preview title\n\nBody".toByteArray()))
    override suspend fun searchFiles(sessionId: String, query: String, limit: Int) = FileSearchResponse(true,
        files = listOf(FileSearchItem("guide.md", "docs", "docs/guide.md", "file")))
    override suspend fun listDirectory(sessionId: String, path: String?) = ListDirectoryResponse(true,
        entries = if (path == "docs") listOf(DirectoryEntry("guide.md", "file"))
            else listOf(DirectoryEntry("docs", "directory")))
}
