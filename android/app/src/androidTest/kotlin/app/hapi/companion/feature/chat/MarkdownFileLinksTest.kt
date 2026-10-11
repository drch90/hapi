package app.hapi.companion.feature.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import app.hapi.companion.feature.files.FileViewerScreen
import app.hapi.companion.feature.files.FileViewerViewModel
import app.hapi.companion.feature.files.FilesGateway
import app.hapi.companion.feature.files.ViewerMode
import app.hapi.companion.ui.markdown.LocalMarkdownLinkHandler
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.markdown.FileLinkTarget
import app.hapi.protocol.wire.FileReadResponse
import app.hapi.protocol.wire.FileSearchResponse
import app.hapi.protocol.wire.GitCommandResponse
import app.hapi.protocol.wire.ListDirectoryResponse
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class MarkdownFileLinksTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val workspace = "/root/workspace/hermes-lite-web"
    private val report = "$workspace/artifacts/review-20261011/review.md"

    @After fun close() { scope.cancel() }

    @Test fun reportCitationOpensTheNativeMarkdownPreview() {
        val selected = mutableStateOf<FileLinkTarget?>(null)
        val gateway = MarkdownLinkFilesGateway()
        compose.setContent {
            HapiTheme {
                val file = selected.value
                if (file == null) {
                    CompositionLocalProvider(LocalMarkdownLinkHandler provides rememberChatLinkHandler(
                        workspacePath = workspace,
                        onOpenFile = { path, line -> selected.value = FileLinkTarget(path, line) },
                    )) {
                        Markdown("[完整报告与修复建议]($report) 已附上。")
                    }
                } else {
                    val model = remember(file) {
                        FileViewerViewModel("session", file.path, null, ViewerMode.FILE, file.line, gateway, scope)
                    }
                    FileViewerScreen(model, onBack = { selected.value = null })
                }
            }
        }
        clickLink("完整报告与修复建议")
        compose.onNodeWithText("Review details").assertIsDisplayed()
        compose.onNodeWithText("# Review details").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(FileLinkTarget(report), selected.value)
            assertEquals(listOf("session" to report), gateway.reads)
        }
    }

    @Test fun pathLabelsAndEncodedUnicodeLinksKeepTheirLineHints() {
        val opened = mutableListOf<FileLinkTarget>()
        val pathLabel = "docs/review.md:12:3"
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(LocalMarkdownLinkHandler provides rememberChatLinkHandler(
                    workspacePath = workspace,
                    onOpenFile = { path, line -> opened += FileLinkTarget(path, line) },
                )) {
                    Markdown("[$pathLabel]($pathLabel)\n\n[中文报告](<$workspace/审查%20报告+📄.md:7>)")
                }
            }
        }
        clickLink(pathLabel)
        clickLink("中文报告")
        compose.runOnIdle {
            assertEquals(listOf(
                FileLinkTarget("docs/review.md", 12),
                FileLinkTarget("$workspace/审查 报告+📄.md", 7),
            ), opened)
        }
    }

    @Test fun absoluteLinksFollowWorkspaceMetadataUpdates() {
        val currentWorkspace = mutableStateOf<String?>(null)
        val opened = mutableListOf<String>()
        val onOpen: (String, Int?) -> Unit = { path, _ -> opened += path }
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(LocalMarkdownLinkHandler provides rememberChatLinkHandler(
                    workspacePath = currentWorkspace.value, onOpenFile = onOpen,
                )) {
                    Markdown("[Report]($report)")
                }
            }
        }
        assertLinked("Report", false)
        compose.runOnIdle { currentWorkspace.value = workspace }
        assertLinked("Report", true)
        clickLink("Report")
        compose.runOnIdle { currentWorkspace.value = "/tmp/worktree" }
        assertLinked("Report", false)
        compose.runOnIdle { assertEquals(listOf(report), opened) }
    }

    @Test fun sessionReferencesAndWebUrlsKeepTheirLinkBehavior() {
        val openedSessions = mutableListOf<String>()
        val openedFiles = mutableListOf<String>()
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(LocalMarkdownLinkHandler provides rememberChatLinkHandler(
                    workspacePath = workspace,
                    onOpenFile = { path, _ -> openedFiles += path },
                    onOpenSession = { openedSessions += it },
                )) {
                    Markdown("[Peer](/sessions/session-id)\n\n[Website](https://example.com/report.md)\n\n[Blocked](javascript:report.md)")
                }
            }
        }
        assertLinked("Website", true)
        assertLinked("Blocked", false)
        clickLink("Peer")
        compose.runOnIdle {
            assertEquals(listOf("session-id"), openedSessions)
            assertTrue(openedFiles.isEmpty())
        }
    }

    private fun textLayout(label: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(label, substring = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single()
    }

    private fun clickLink(label: String) {
        val layout = textLayout(label)
        val offset = layout.layoutInput.text.text.indexOf(label)
        assertTrue(offset >= 0)
        compose.onNodeWithText(label, substring = true)
            .performTouchInput { click(layout.getBoundingBox(offset).center) }
    }

    private fun assertLinked(label: String, expected: Boolean) {
        val text = textLayout(label).layoutInput.text
        val offset = text.text.indexOf(label)
        assertTrue(offset >= 0)
        assertEquals(expected, text.getLinkAnnotations(offset, offset + label.length).isNotEmpty())
    }
}

private class MarkdownLinkFilesGateway : FilesGateway {
    val reads = mutableListOf<Pair<String, String>>()
    override suspend fun gitStatus(sessionId: String) = GitCommandResponse(true, stdout = "")
    override suspend fun gitDiffNumstat(sessionId: String, staged: Boolean) = GitCommandResponse(true, stdout = "")
    override suspend fun gitDiffFile(sessionId: String, path: String, staged: Boolean?) = GitCommandResponse(true, stdout = "")
    override suspend fun readFile(sessionId: String, path: String): FileReadResponse {
        reads += sessionId to path
        return FileReadResponse(true, content = Base64.getEncoder().encodeToString(
            "# Review details\n\nThe report is open in the native preview.".toByteArray(),
        ))
    }
    override suspend fun searchFiles(sessionId: String, query: String, limit: Int) = FileSearchResponse(true, files = emptyList())
    override suspend fun listDirectory(sessionId: String, path: String?) = ListDirectoryResponse(true, entries = emptyList())
}
