package app.hapi.companion.feature.chat.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ContextUsageTone
import app.hapi.companion.feature.chat.ContextUsageUi
import app.hapi.companion.feature.chat.formatContextTokens
import app.hapi.companion.ui.theme.hapi

/** Mobile Web's compact label, with a native, scrollable details dialog. */
@Composable
internal fun ContextUsageIndicator(usage: ContextUsageUi, modifier: Modifier = Modifier) {
    var detailsOpen by rememberSaveable { mutableStateOf(false) }
    val detailsLabel = stringResource(R.string.chat_context_details)
    val color = when (usage.tone) {
        ContextUsageTone.Normal -> MaterialTheme.hapi.hint
        ContextUsageTone.Warning -> Color(0xFFF59E0B)
        ContextUsageTone.Danger -> MaterialTheme.colorScheme.error
    }
    TextButton(
        onClick = { detailsOpen = true },
        modifier = modifier.testTag("chat-context-usage").semantics { contentDescription = detailsLabel },
    ) {
        Text(
            text = if (usage.window != null) {
                stringResource(R.string.chat_context_compact, formatContextTokens(usage.window), usage.remainingPercentage!!)
            } else stringResource(R.string.chat_context_compact_tokens, formatContextTokens(usage.used)),
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
    }
    if (detailsOpen) {
        AlertDialog(
            onDismissRequest = { detailsOpen = false },
            title = { Text(detailsLabel) },
            text = {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    usage.cacheRead?.let { Text(stringResource(R.string.chat_context_cache, formatContextTokens(it))) }
                    Text(
                        if (usage.usedPercentage != null) stringResource(R.string.chat_context_used, formatContextTokens(usage.used), usage.usedPercentage)
                        else stringResource(R.string.chat_context_used_tokens, formatContextTokens(usage.used)),
                    )
                    usage.remaining?.let {
                        Text(stringResource(R.string.chat_context_remaining, formatContextTokens(it), usage.remainingPercentage!!))
                    }
                    usage.usedPercentage?.let {
                        LinearProgressIndicator(progress = { it / 100f }, color = color, modifier = Modifier.fillMaxWidth())
                    }
                }
            },
            confirmButton = { TextButton(onClick = { detailsOpen = false }) { Text(stringResource(R.string.chat_context_close)) } },
        )
    }
}
