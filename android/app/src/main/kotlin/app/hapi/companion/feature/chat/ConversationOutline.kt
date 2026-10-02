package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.VisibleChatBlock

internal data class OutlineItem(val id: String, val label: String, val createdAt: Long)

internal fun conversationOutline(blocks: List<VisibleChatBlock>): List<OutlineItem> = blocks.filterIsInstance<UserTextBlock>()
    .filter { it.invokedAt != null || it.status == "failed" }
    .map { block ->
        val label = block.text.replace(Regex("\\s+"), " ").trim()
        OutlineItem(block.stableId, if (label.length > 96) label.take(93).trimEnd() + "..." else label, block.createdAt)
    }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationOutline(items: List<OutlineItem>, hasMore: Boolean, onDismiss: () -> Unit,
    onSelect: (String) -> Unit, onOlder: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(stringResource(R.string.chat_outline), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(16.dp))
        if (items.isEmpty()) Text(stringResource(R.string.chat_outline_empty), Modifier.padding(16.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
            if (hasMore) item("older") { TextButton(onClick = onOlder) { Text(stringResource(R.string.chat_history_load)) } }
            items(items, key = { it.id }) { item ->
                DropdownMenuItem(text = { Column {
                    Text(item.label.ifEmpty { stringResource(R.string.chat_empty_title) }, maxLines = 3)
                    Text(messageTimestamp(item.createdAt), style = MaterialTheme.typography.labelSmall)
                } }, onClick = { onSelect(item.id) })
            }
        }
    }
}
