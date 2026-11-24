package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.feature.chat.LocalChatInspection
import app.hapi.companion.feature.chat.messagePreview
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.ChatAttachment
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.translatedFrom
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Operator prompt: right-aligned bubble (whitespace preserved — prompts are
 * not rendered as markdown, matching the web user bubble), attachments as
 * image thumbnails (decoded from the wire `previewUrl` data URL — both
 * Android- and web-sent messages carry one, and optimistic rows do too, so
 * thumbnails appear instantly on send) or filename chips, and a failed-send
 * tap-to-retry hint (B-M3f upgrades the former chips-only rendering).
 *
 * Hub-translated prompts (`meta.translatedFrom`) show what the user typed by
 * default; a caption under the bubble flips to the English actually sent to
 * the agent (web `HappyUserMessage`). Selection copies the visible variant.
 */
@Composable
fun UserTextBlockView(block: UserTextBlock, modifier: Modifier = Modifier) {
    val translatedFrom = block.translatedFrom
    var showSentText by rememberSaveable(block.id) { mutableStateOf(false) }
    val visibleText = if (translatedFrom != null && !showSentText) translatedFrom else block.text
    val preview = remember(visibleText) { messagePreview(visibleText) }
    val inspection = LocalChatInspection.current
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val maxBubbleWidth = maxWidth * 0.85f
        Row(modifier = Modifier.fillMaxWidth()) {
            Spacer(modifier = Modifier.width(48.dp).weight(1f))
            Column(horizontalAlignment = Alignment.End) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 4.dp),
                    modifier = Modifier.widthIn(max = maxBubbleWidth),
                ) {
                    Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        SelectionContainer {
                            Text(text = preview.text, style = HapiTypography.body)
                        }
                        if (preview.end < visibleText.length) {
                            TextButton(onClick = { inspection?.openMessage(block.id) }, enabled = inspection != null) {
                                Text(stringResource(R.string.chat_view_full_message))
                            }
                        }
                        block.attachments?.takeIf { it.isNotEmpty() }?.let { attachments ->
                            Column(
                                modifier = Modifier.padding(top = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                                horizontalAlignment = Alignment.End,
                            ) {
                                attachments.forEach { AttachmentView(block.id, it) }
                            }
                        }
                    }
                }
                if (translatedFrom != null) {
                    Text(
                        text = stringResource(R.string.chat_translated_label) + " · " + stringResource(
                            if (showSentText) R.string.chat_translated_show_original else R.string.chat_translated_show_sent,
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .clickable(role = Role.Button) { showSentText = !showSentText }
                            .padding(top = 2.dp, end = 4.dp),
                    )
                }
                app.hapi.companion.feature.chat.MessageActions(app.hapi.companion.feature.chat.shareMessage(block)!!)
                if (block.status == "failed") {
                    val interactions = LocalChatInteractions.current
                    val retryLocalId = block.localId
                    val retryModifier = if (interactions != null && retryLocalId != null) {
                        Modifier.clickable { interactions.retryFailedMessage(retryLocalId) }
                    } else {
                        Modifier
                    }
                    Text(
                        text = stringResource(
                            if (interactions != null && retryLocalId != null) {
                                R.string.chat_not_delivered_retry
                            } else {
                                R.string.chat_not_delivered
                            },
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = retryModifier.padding(top = 2.dp, end = 4.dp),
                    )
                }
            }
        }
    }
}

/**
 * Image previews open the shared gallery; other attachments show name and size.
 */
@Composable
private fun AttachmentView(blockId: String, attachment: ChatAttachment) {
    val image = app.hapi.companion.feature.chat.media.attachmentImage(blockId, attachment)
    if (image == null) AttachmentChip(attachment)
    else {
        Column {
            app.hapi.companion.feature.chat.media.ChatImagePreview(
                image, app.hapi.companion.feature.chat.LocalChatMedia.current.imageLoader,
                Modifier.heightIn(max = 180.dp).clip(RoundedCornerShape(10.dp)),
            )
            Text(attachment.filename, style = MaterialTheme.typography.labelSmall,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun AttachmentChip(attachment: ChatAttachment) {
    Surface(
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.55f),
        shape = RoundedCornerShape(8.dp),
    ) {
        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
            Text(
                text = "${if (attachment.mimeType.startsWith("image/")) "🖼" else "📎"} ${attachment.filename}",
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(app.hapi.companion.feature.chat.media.mediaFileSize(attachment.size),
                style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun UserTextBlockPreview() {
    HapiTheme {
        Surface {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            UserTextBlockView(
                UserTextBlock(
                    id = "u1",
                    localId = null,
                    createdAt = 0,
                    invokedAt = null,
                    text = "Fix the failing pagination test and explain the root cause",
                    attachments = null,
                    status = null,
                    originalText = null,
                    meta = null,
                ),
            )
            UserTextBlockView(
                UserTextBlock(
                    id = "u2",
                    localId = null,
                    createdAt = 0,
                    invokedAt = null,
                    text = "Here is the screenshot",
                    attachments = listOf(
                        ChatAttachment(
                            id = "a1",
                            filename = "screenshot.png",
                            mimeType = "image/png",
                            size = 1024.0,
                            path = "/uploads/screenshot.png",
                        ),
                    ),
                    status = "failed",
                    originalText = null,
                    meta = null,
                ),
            )
            UserTextBlockView(
                UserTextBlock(
                    id = "u3",
                    localId = null,
                    createdAt = 0,
                    invokedAt = null,
                    text = "Fix the login bug",
                    attachments = null,
                    status = null,
                    originalText = null,
                    meta = buildJsonObject { put("translatedFrom", JsonPrimitive("修复登录问题")) },
                ),
            )
            }
        }
    }
}
