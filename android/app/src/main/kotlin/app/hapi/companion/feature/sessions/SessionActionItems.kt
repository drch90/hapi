package app.hapi.companion.feature.sessions

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import app.hapi.companion.R
import app.hapi.protocol.session.SessionReferences

/** The list and chat use one catalog and the same lifecycle gates. */
@Composable
internal fun SessionActionItems(
    id: String, title: String, active: Boolean, pinned: Boolean, globalPinned: Boolean,
    dismiss: () -> Unit, rename: () -> Unit, pin: (PinMode) -> Unit, unread: () -> Unit,
    archive: () -> Unit, reopen: () -> Unit, delete: () -> Unit, newInDirectory: (() -> Unit)? = null,
) {
    val context = LocalContext.current

    ActionItem(dismiss, R.string.sessions_action_rename, rename)
    ActionItem(dismiss, R.string.sessions_copy_reference) {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
            ClipData.newPlainText(title, SessionReferences.copyText(title, id)))
        Toast.makeText(context, R.string.sessions_reference_copied, Toast.LENGTH_SHORT).show()
    }
    ActionItem(dismiss, R.string.sessions_mark_unread, unread)
    ActionItem(dismiss, if (pinned) R.string.sessions_action_unpin else R.string.sessions_action_pin_project) { pin(if (pinned) PinMode.None else PinMode.Project) }
    ActionItem(dismiss, if (globalPinned) R.string.sessions_action_unpin else R.string.sessions_action_pin_global) { pin(if (globalPinned) PinMode.None else PinMode.Global) }
    newInDirectory?.let { ActionItem(dismiss, R.string.sessions_new_in_directory, it) }
    if (active) ActionItem(dismiss, R.string.sessions_action_archive, archive)
    else {
        ActionItem(dismiss, R.string.sessions_action_reopen, reopen)
        ActionItem(dismiss, R.string.sessions_action_delete, delete)
    }
}

@Composable
private fun ActionItem(dismiss: () -> Unit, label: Int, action: () -> Unit) {
    DropdownMenuItem(text = { Text(stringResource(label)) }, onClick = { dismiss(); action() })
}
