package app.hapi.companion.feature.chat

import android.content.Intent
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.hapi.companion.R
import app.hapi.companion.ui.components.FullTextAction
import app.hapi.protocol.chat.VisibleChatBlock
import coil.compose.AsyncImage
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class MessageSelection(
    val active: Boolean,
    val selected: Set<String>,
    val toggle: (ShareMessage) -> Unit,
)

internal val LocalMessageSelection = compositionLocalOf<MessageSelection?> { null }

@Composable
internal fun MessageActions(message: ShareMessage) {
    val selection = LocalMessageSelection.current
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (message.user) Alignment.End else Alignment.Start) {
        Text(messageTimestamp(message.timestamp), style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.CenterVertically) {
            FullTextAction(message.text, compact = true)
            if (selection != null) {
                if (selection.active) {
                    val label = stringResource(R.string.chat_share_select)
                    Checkbox(checked = message.id in selection.selected, onCheckedChange = { selection.toggle(message) },
                        modifier = Modifier.semantics { contentDescription = label })
                } else {
                    IconButton(onClick = { selection.toggle(message) }) {
                        Icon(Icons.Default.Share, stringResource(R.string.chat_share_image))
                    }
                }
            }
        }
    }
}

/** Screen-owned selection survives LazyColumn recycling and never selects tool sidechains. */
@Composable
internal fun MessageActionsHost(
    sessionId: String,
    blocks: List<VisibleChatBlock>,
    modifier: Modifier = Modifier,
    onSelectionStart: () -> Unit,
    content: @Composable () -> Unit,
) {
    key(sessionId) {
        var active by remember { mutableStateOf(false) }
        var selected by remember { mutableStateOf<Map<String, ShareMessage>>(emptyMap()) }
        var files by remember { mutableStateOf<List<File>>(emptyList()) }
        var busy by remember { mutableStateOf(false) }
        var pages by remember { mutableIntStateOf(0) }
        var failed by remember { mutableStateOf(false) }
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        // Retain selection across history-window eviction; update retained messages while loaded.
        // Track transcript order, including newly prepended pages, independently of selection order.
        var order by remember { mutableStateOf<List<String>>(emptyList()) }
        LaunchedEffect(blocks, active) {
            if (!active) {
                order = emptyList()
                return@LaunchedEffect
            }
            val live = blocks.mapNotNull(::shareMessage)
            order = mergeShareOrder(order, live.map { it.id })
            val updates = live.filter { it.id in selected }.associateBy { it.id }
            val updated = selected + updates
            if (updated != selected) selected = updated
        }
        fun cancel() {
            active = false
            selected = emptyMap()
            failed = false
        }
        BackHandler(active && files.isEmpty() && !busy) { cancel() }
        val selection = MessageSelection(active, selected.keys) { message ->
            if (!active) {
                onSelectionStart()
                active = true
            }
            selected = if (message.id in selected) selected - message.id else selected + (message.id to message)
        }
        Column(modifier) {
            if (active) {
                Surface(tonalElevation = 3.dp) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                        Text(stringResource(R.string.chat_share_selected, selected.size), style = MaterialTheme.typography.labelLarge)
                        Row {
                            TextButton(onClick = { cancel() }, enabled = !busy) { Text(stringResource(R.string.chat_share_cancel)) }
                            TextButton(enabled = selected.isNotEmpty() && !busy, onClick = {
                                val live = blocks.mapNotNull(::shareMessage)
                                val currentOrder = mergeShareOrder(order, live.map { it.id })
                                val currentSelection = selected + live.filter { it.id in selected }.associateBy { it.id }
                                val snapshot = currentOrder.mapNotNull { currentSelection[it] }
                                val userLabel = context.getString(R.string.chat_share_user)
                                val assistantLabel = context.getString(R.string.chat_share_assistant)
                                busy = true
                                failed = false
                                pages = 0
                                scope.launch {
                                    try {
                                        files = withContext(Dispatchers.Default) {
                                            exportMessageImages(context, snapshot, userLabel, assistantLabel) {
                                                withContext(Dispatchers.Main) { pages = it }
                                            }
                                        }
                                    } catch (cancel: CancellationException) {
                                        throw cancel
                                    } catch (_: Exception) {
                                        failed = true
                                    } finally {
                                        busy = false
                                    }
                                }
                            }) { Text(stringResource(R.string.chat_share_generate)) }
                        }
                        if (busy) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                            Text(stringResource(R.string.chat_share_progress, pages))
                        }
                        if (failed) Text(stringResource(R.string.chat_share_failed), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
            Box(Modifier.weight(1f)) {
                CompositionLocalProvider(LocalMessageSelection provides selection, content = content)
            }
        }
        if (files.isNotEmpty()) {
            Dialog(onDismissRequest = { files = emptyList(); failed = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
                Surface(Modifier.fillMaxSize().padding(12.dp), shape = MaterialTheme.shapes.large) {
                    Column(Modifier.padding(12.dp)) {
                        Text(stringResource(R.string.chat_share_preview), style = MaterialTheme.typography.titleMedium)
                        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            items(files, key = { it.path }) { file ->
                                val ratio = remember(file) {
                                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                                    BitmapFactory.decodeFile(file.path, bounds)
                                    bounds.outWidth.toFloat() / bounds.outHeight.coerceAtLeast(1)
                                }
                                AsyncImage(model = file, contentDescription = stringResource(R.string.chat_share_preview),
                                    modifier = Modifier.fillMaxWidth().aspectRatio(ratio.coerceAtLeast(0.1f)))
                            }
                        }
                        if (failed) Text(stringResource(R.string.chat_share_failed), color = MaterialTheme.colorScheme.error)
                        Row {
                            TextButton(onClick = { files = emptyList(); failed = false }) { Text(stringResource(R.string.chat_share_cancel)) }
                            TextButton(onClick = {
                                try {
                                    context.startActivity(Intent.createChooser(messageImageShareIntent(context, files), null))
                                    failed = false
                                } catch (_: Exception) { failed = true }
                            }) { Text(stringResource(R.string.chat_share_image)) }
                        }
                    }
                }
            }
        }
    }
}
