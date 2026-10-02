package app.hapi.companion.feature.directorybrowser

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.Machine

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(api: HapiApi, machines: List<Machine>, onBack: () -> Unit, onStart: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val fallback = stringResource(R.string.directory_browser_empty)
    val controller = remember(api) { RemoteDirectoryBrowserController(scope,
        { machine, path, hidden -> api.listMachineDirectory(machine, path, hidden) }, fallback) }
    val state by controller.state.collectAsState()
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var machineMenu by remember { mutableStateOf(false) }
    val machine = machines.firstOrNull { it.id == selected } ?: machines.firstOrNull { it.active && !it.metadata?.workspaceRoots.isNullOrEmpty() }
        ?: machines.firstOrNull()
    LaunchedEffect(machine?.id, machine?.active, machine?.metadata?.workspaceRoots) {
        controller.close()
        machine?.takeIf { it.active }?.let { controller.open(it.id, it.metadata?.workspaceRoots.orEmpty()) }
    }
    DisposableEffect(controller) { onDispose { controller.close() } }
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.workspace_title)) },
        navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.chat_back)) } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp)) {
            Box {
                TextButton(onClick = { machineMenu = true }) { Text(machine?.metadata?.displayName ?: machine?.metadata?.host ?: stringResource(R.string.workspace_machine)) }
                DropdownMenu(machineMenu, { machineMenu = false }) {
                    machines.forEach { item -> DropdownMenuItem(
                        text = { Text(item.metadata?.displayName ?: item.metadata?.host ?: item.id.take(8)) },
                        onClick = { selected = item.id; machineMenu = false }) }
                }
            }
            when {
                machine?.active != true -> Text(stringResource(R.string.workspace_offline))
                machine.metadata?.workspaceRoots.isNullOrEmpty() -> Text(stringResource(R.string.workspace_no_roots))
                else -> {
                    Row(Modifier.horizontalScroll(rememberScrollState())) { state.roots.forEach { root -> TextButton(onClick = { controller.navigate(root) }) { Text(root, maxLines = 1) } } }
                    Row { TextButton(onClick = controller::navigateUp, enabled = state.canGoUp) { Text(stringResource(R.string.directory_browser_up)) }
                        TextButton(onClick = controller::refresh, enabled = !state.loading) { Text(stringResource(R.string.directory_browser_refresh)) } }
                    Row { Text(stringResource(R.string.workspace_hidden), Modifier.weight(1f)); Switch(state.includeHidden, controller::setIncludeHidden) }
                    Text(state.path, style = MaterialTheme.typography.bodySmall)
                    Row(Modifier.horizontalScroll(rememberScrollState())) { state.breadcrumbs.forEach { crumb -> TextButton(onClick = { controller.navigate(crumb.path) }) { Text(crumb.label, maxLines = 1) } } }
                    if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                    state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    LazyColumn(Modifier.weight(1f)) {
                        items(state.entries, key = { it.name }) { item ->
                            ListItem(headlineContent = { Text(item.name) }, trailingContent = {
                                TextButton(onClick = { controller.navigateEntry(item.name) }) { Text(stringResource(R.string.chat_link_open)) }
                            })
                        }
                    }
                    Button(onClick = { onStart(machine.id, state.path) },
                        enabled = state.open && !state.loading && state.error == null, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.workspace_start))
                    }
                }
            }
        }
    }
}
