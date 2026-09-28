package app.hapi.companion.feature.chat

import android.content.ClipboardManager
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.feature.chat.blocks.AgentTextBlockView
import app.hapi.companion.feature.chat.blocks.UserTextBlockView
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.UserTextBlock
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class MessageSharingTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun bothRolesHaveActionsAndSelectionCanBeCancelledAtLargeFont() {
        val user = UserTextBlock("user", null, 1000, null, "Question", null, null, null, null)
        val agent = AgentTextBlock("agent", null, 2000, null, text = "Answer", meta = null)
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                    MessageActionsHost("test", listOf(user, agent), Modifier.width(320.dp).fillMaxHeight(), onSelectionStart = {}) {
                        Column {
                            UserTextBlockView(user)
                            AgentTextBlockView(agent)
                        }
                    }
                }
            }
        }
        compose.onNodeWithText(messageTimestamp(1000)).assertExists()
        compose.onNodeWithText(messageTimestamp(2000)).assertExists()
        compose.onAllNodesWithContentDescription(context.getString(R.string.chat_share_image)).assertCountEquals(2)
        compose.onAllNodesWithContentDescription(context.getString(R.string.chat_copy_full_content))[1].performClick()
        compose.runOnIdle {
            val clipboard = context.getSystemService(ClipboardManager::class.java)
            assertEquals("Answer", clipboard.primaryClip!!.getItemAt(0).text.toString())
        }
        compose.onAllNodesWithContentDescription(context.getString(R.string.chat_share_image))[0].performClick()
        compose.onAllNodesWithContentDescription(context.getString(R.string.chat_share_select))[1].performClick()
        compose.onNodeWithText(context.getString(R.string.chat_share_selected, 2)).assertExists()
        compose.onNodeWithText(context.getString(R.string.chat_share_cancel)).performClick()
        compose.onAllNodesWithContentDescription(context.getString(R.string.chat_share_image)).assertCountEquals(2)
    }

    @Test fun longExportsUseBoundedPngPagesAndReadableUris() = runBlocking {
        val source = ShareMessage("a", 0, false, "中文 👩🏽‍💻 code\n".repeat(1500), listOf("file.txt"))
        val files = exportMessageImages(context, listOf(source), "User", "Assistant")
        try {
            assertTrue(files.size > 1)
            for (file in files) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.path, bounds)
                assertEquals(SHARE_IMAGE_WIDTH, bounds.outWidth)
                assertTrue(bounds.outHeight in 1..SHARE_IMAGE_HEIGHT)
                assertEquals("image/png", bounds.outMimeType)
            }
            val intent = messageImageShareIntent(context, files)
            assertEquals(Intent.ACTION_SEND_MULTIPLE, intent.action)
            assertEquals("image/png", intent.type)
            assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            assertEquals(files.size, intent.clipData!!.itemCount)
            context.contentResolver.openInputStream(intent.clipData!!.getItemAt(0).uri)!!.use {
                assertEquals(137, it.read()) // PNG signature
            }
            assertEquals(Intent.ACTION_SEND, messageImageShareIntent(context, files.take(1)).action)
        } finally {
            files.forEach { it.delete() }
        }
    }
}
