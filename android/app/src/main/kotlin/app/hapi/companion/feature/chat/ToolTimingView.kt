package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.hapi.companion.R
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolState
import kotlinx.coroutines.delay

@Composable
internal fun ToolTimingView(tool: ChatToolCall, compact: Boolean = false) {
    var now by remember(tool.id) { mutableLongStateOf(System.currentTimeMillis()) }
    val owner = ProcessLifecycleOwner.get()
    LaunchedEffect(tool.id, tool.state, owner) {
        if (tool.state == ToolState.RUNNING) {
            owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    now = System.currentTimeMillis()
                    delay(1000)
                }
            }
        }
    }
    val timing = toolTiming(tool, now)
    val missing = "—"
    if (compact) {
        val awaitingApproval = tool.permission?.status == "pending"
        val status = stringResource(when {
            awaitingApproval -> R.string.chat_tool_status_approval
            tool.state == ToolState.PENDING -> R.string.chat_tool_status_pending
            tool.state == ToolState.RUNNING -> R.string.chat_timing_running
            tool.state == ToolState.ERROR -> R.string.chat_tool_status_error
            else -> R.string.chat_tool_status_completed
        })
        Text(
            "$status · ${timing.elapsed?.let(::elapsedTime) ?: missing}",
            style = MaterialTheme.typography.labelSmall,
            color = when {
                awaitingApproval -> MaterialTheme.colorScheme.tertiary
                tool.state == ToolState.ERROR -> MaterialTheme.colorScheme.error
                tool.state == ToolState.RUNNING -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            },
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag("tool-timing-summary-${tool.id}"),
        )
        return
    }
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp).testTag("tool-timing-details-${tool.id}")) {
        Text(stringResource(R.string.chat_timing_start, timing.start?.let { messageTimestamp(it) }
            ?: if (tool.state == ToolState.PENDING) stringResource(R.string.chat_timing_pending) else missing),
            style = MaterialTheme.typography.labelSmall)
        Text(stringResource(R.string.chat_timing_end, timing.end?.let { messageTimestamp(it) }
            ?: if (tool.state == ToolState.RUNNING) stringResource(R.string.chat_timing_running) else missing),
            style = MaterialTheme.typography.labelSmall)
        Text(stringResource(R.string.chat_timing_elapsed, timing.elapsed?.let(::elapsedTime) ?: missing),
            style = MaterialTheme.typography.labelSmall)
    }
}
