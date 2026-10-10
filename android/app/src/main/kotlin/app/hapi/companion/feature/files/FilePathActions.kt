package app.hapi.companion.feature.files

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

internal data class FilePathTarget(val path: String, val isDirectory: Boolean = false)

/** The full path remains available even when the compact bar truncates it. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun FilePathBar(path: String, onActions: () -> Unit) {
    val actionsLabel = stringResource(R.string.files_path_actions)
    Row(
        modifier = Modifier.fillMaxWidth()
            .combinedClickable(role = Role.Button, onClick = onActions,
                onLongClick = onActions, onLongClickLabel = actionsLabel)
            .heightIn(min = 48.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(path, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f))
        Icon(Icons.Filled.MoreVert, contentDescription = actionsLabel)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FilePathActionsSheet(
    target: FilePathTarget,
    onDismiss: () -> Unit,
    onSendToComposer: ((String) -> Unit)?,
) {
    @Suppress("DEPRECATION")
    val clipboard = LocalClipboardManager.current
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
            Text(stringResource(if (target.isDirectory) R.string.files_folder_actions else R.string.files_file_actions),
                style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp))
            SelectionContainer {
                Text(target.path, style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
            }
            ListItem(
                headlineContent = { Text(stringResource(R.string.files_viewer_copy_path)) },
                modifier = Modifier.clickable(role = Role.Button) {
                    clipboard.setText(AnnotatedString(target.path))
                    onDismiss()
                },
            )
            onSendToComposer?.let { send ->
                ListItem(
                    headlineContent = { Text(stringResource(R.string.files_send_to_composer)) },
                    modifier = Modifier.clickable(role = Role.Button) {
                        onDismiss()
                        send(target.path)
                    },
                )
            }
        }
    }
}
