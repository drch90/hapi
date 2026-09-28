package app.hapi.companion.notifications

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.di.LocalAppGraph

@Composable
internal fun LocalNotificationSettingsView() {
    val context = LocalContext.current
    val graph = LocalAppGraph.current
    val enabled by graph.localNotifications.enabled.collectAsState()
    val status by graph.localNotifications.status.collectAsState()
    val registry by graph.hubRegistry.state.collectAsState()
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            graph.localNotifications.setEnabled(true)
            LocalNotificationService.startIfEnabled(context)
        } else {
            graph.localNotifications.status.value = ReceptionStatus.PermissionRequired
        }
    }
    Column {
        Text(stringResource(R.string.local_notifications_title), style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
        Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = MaterialTheme.shapes.medium) {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.local_notifications_enable), Modifier.weight(1f))
                    Switch(checked = enabled, enabled = registry.activeHubUrl != null, onCheckedChange = { value ->
                        if (!value) LocalNotificationService.stop(context)
                        else if (LocalNotificationService.canNotify(context)) {
                            graph.localNotifications.setEnabled(true)
                            LocalNotificationService.startIfEnabled(context)
                        } else if (Build.VERSION.SDK_INT >= 33) {
                            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else graph.localNotifications.status.value = ReceptionStatus.PermissionRequired
                    })
                }
                Text(stringResource(status.label()), style = MaterialTheme.typography.bodySmall)
                Text(stringResource(R.string.local_notifications_description), style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 8.dp))
                if (status == ReceptionStatus.PermissionRequired) {
                    TextButton(onClick = {
                        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                    }) { Text(stringResource(R.string.local_notifications_system_settings)) }
                }
                if (enabled && status in setOf(ReceptionStatus.Stopped, ReceptionStatus.StartFailed, ReceptionStatus.PairingRequired)) {
                    TextButton(onClick = { LocalNotificationService.startIfEnabled(context) }) {
                        Text(stringResource(R.string.local_notifications_retry))
                    }
                }
            }
        }
    }
}
