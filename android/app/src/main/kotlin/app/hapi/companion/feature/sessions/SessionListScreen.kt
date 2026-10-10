package app.hapi.companion.feature.sessions

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.components.AgentFlavorIcon
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.PendingRequest
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SummaryText
import app.hapi.protocol.wire.TodoProgress

/**
 * The session list (B-M2b) — standalone screen: navigation and app graph stay
 * outside; taps surface through [onOpenSession].
 *
 * Inventory (mirrors the web sidebar semantics):
 * - offline banner over snapshot data, machine filter chips (≥ 2 machines),
 *   pull-to-refresh, empty state;
 * - global pins, in-progress, active, then collapsible workspace groups;
 *   project pins stay at the top of their workspace;
 * - per row: flavor brand icon + title, spinner while a turn is in flight,
 *   summary line, `project · worktree · machine` meta line (machine only
 *   when it disambiguates), relative `updatedAt`, pending-request badge,
 *   todo-progress chip, unread dot; disconnected rows are dimmed —
 *   connected is the resting state, so no presence dot (web parity);
 * - long-press → actions sheet: pin (none/project/global), rename (dialog),
 *   reopen (inactive rows; navigates into the possibly-superseding id),
 *   archive, delete (confirm; 409 while active) — optimistic store updates;
 *   failures land in a snackbar (B-M2b + B-M3ce).
 *
 * The host (`HomeScreen` via Navigation) constructs the ViewModel from the
 * active `HubGraph` and routes [onOpenSession] to the chat screen. This
 * screen starts/stops the ViewModel — and with it the global SSE
 * subscription — with its composition.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    viewModel: SessionListViewModel,
    onOpenSession: (sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
    /** Shows the "+" FAB (new-session form, B-M3d) when non-null. */
    onNewSession: (() -> Unit)? = null,
    onNewInDirectory: ((String?, String) -> Unit)? = null,
) {
    val state by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var sheetRow by remember { mutableStateOf<SessionRowUi?>(null) }
    var renameRow by remember { mutableStateOf<SessionRowUi?>(null) }
    var archiveRow by remember { mutableStateOf<SessionRowUi?>(null) }
    var markAllRead by remember { mutableStateOf(false) }
    var deleteRow by remember { mutableStateOf<SessionRowUi?>(null) }

    DisposableEffect(viewModel) {
        viewModel.start()
        onDispose { viewModel.stop() }
    }

    val context = LocalContext.current
    LaunchedEffect(viewModel, context) {
        viewModel.errors.collect { error ->
            val label = context.getString(
                when (error) {
                    is SessionListError.PinFailed -> R.string.sessions_error_pin
                    is SessionListError.ArchiveFailed -> R.string.sessions_error_archive
                    is SessionListError.RenameFailed -> R.string.sessions_error_rename
                    is SessionListError.DeleteFailed -> R.string.sessions_error_delete
                    is SessionListError.ReopenFailed -> R.string.sessions_error_reopen
                    is SessionListError.MachinesRefreshFailed -> R.string.sessions_error_machines
                },
            )
            // The 409-on-delete conflict gets explicit wording; other messages
            // are hub/server text appended verbatim.
            val message = when {
                error is SessionListError.DeleteFailed && error.stillActive ->
                    context.getString(R.string.sessions_error_delete_active)
                else -> error.message
            }
            snackbarHostState.showSnackbar(message?.let { "$label: $it" } ?: label)
        }
    }

    // Reopen may hand back a superseding id — open whatever the hub returned.
    LaunchedEffect(viewModel) {
        viewModel.reopened.collect { sessionId ->
            viewModel.onSessionOpened(sessionId)
            onOpenSession(sessionId)
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            OutlinedTextField(value = state.filters.query,
                onValueChange = { viewModel.setFilters(state.filters.copy(query = it)) },
                label = { Text(stringResource(R.string.sessions_search)) }, singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
            if (state.unreadCount > 0) {
                TextButton(onClick = { markAllRead = true }) { Text(stringResource(R.string.sessions_mark_all_read, state.unreadCount)) }
            }
            if (state.isOffline) {
                OfflineBanner()
            }
            state.machineFilters.find { it.id == state.activeMachineFilter }?.let { filter ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.sessions_filter_summary, machineFilterLabel(filter)),
                        style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = { viewModel.setMachineFilter(null) }) { Text(stringResource(R.string.sessions_clear_filter)) }
                }
            }
            PullToRefreshBox(
                isRefreshing = state.isRefreshing,
                onRefresh = viewModel::refresh,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                if (state.rows.isEmpty()) {
                    if (state.filters.applied || state.activeMachineFilter != null) {
                        Text(stringResource(R.string.sessions_no_matches), modifier = Modifier.padding(16.dp))
                    } else EmptyState(hasLoaded = state.hasLoaded, isOffline = state.isOffline)
                } else {
                    SessionRows(
                        sections = state.sections,
                        searching = state.filters.query.isNotBlank(),
                        onToggleSection = viewModel::toggleSection,
                        onOpen = { sessionId ->
                            viewModel.onSessionOpened(sessionId)
                            onOpenSession(sessionId)
                        },
                        onLongPress = { sheetRow = it },
                        onNewInDirectory = onNewInDirectory,
                    )
                }
            }
        }
        onNewSession?.let { openNewSession ->
            FloatingActionButton(
                onClick = openNewSession,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp),
            ) {
                Icon(
                    Icons.Default.Add,
                    contentDescription = stringResource(R.string.new_session_fab),
                )
            }
        }
        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    sheetRow?.let { selected ->
        val row = state.rows.firstOrNull { it.id == selected.id } ?: selected
        SessionActionsSheet(
            row = row,
            onUnread = { viewModel.markUnread(row.id) },
            onNewInDirectory = row.summary.metadata?.let { meta -> onNewInDirectory?.let { createSession ->
                { createSession(meta.machineId, meta.worktree?.basePath ?: meta.path) }
            } },
            onDismiss = { sheetRow = null },
            onSetPinMode = { mode ->
                viewModel.setPinMode(row.id, mode)
                sheetRow = null
            },
            onArchive = {
                archiveRow = row
                sheetRow = null
            },
            onRename = {
                renameRow = row
                sheetRow = null
            },
            onReopen = {
                viewModel.reopenSession(row.id)
                sheetRow = null
            },
            onDelete = {
                deleteRow = row
                sheetRow = null
            },
        )
    }
    archiveRow?.let { row ->
        ArchiveSessionDialog(row.title, onDismiss = { archiveRow = null }, onConfirm = {
            viewModel.archiveSession(row.id); archiveRow = null
        })
    }
    if (markAllRead) {
        AlertDialog(onDismissRequest = { markAllRead = false },
            text = { Text(stringResource(R.string.sessions_mark_all_read_confirm, state.unreadCount)) },
            confirmButton = { TextButton(onClick = { viewModel.markAllRead(); markAllRead = false }) {
                Text(stringResource(R.string.sessions_mark_all_read, state.unreadCount)) } },
            dismissButton = { TextButton(onClick = { markAllRead = false }) { Text(stringResource(R.string.chat_cancel)) } })
    }
    renameRow?.let { row ->
        RenameSessionDialog(
            initialName = row.summary.metadata?.name ?: row.title,
            onConfirm = { name ->
                viewModel.renameSession(row.id, name)
                renameRow = null
            },
            onDismiss = { renameRow = null },
        )
    }
    deleteRow?.let { row ->
        DeleteSessionDialog(
            sessionTitle = row.title,
            onConfirm = {
                viewModel.deleteSession(row.id)
                deleteRow = null
            },
            onDismiss = { deleteRow = null },
        )
    }
}

// ------------------------------------------------------------------ list --

@Composable
internal fun SessionRows(
    sections: List<SessionSectionUi>,
    searching: Boolean,
    onToggleSection: (String) -> Unit,
    onOpen: (String) -> Unit,
    onLongPress: (SessionRowUi) -> Unit,
    onNewInDirectory: ((String?, String) -> Unit)? = null,
) {
    LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
        for (section in sections) {
            item(key = "header:${section.id}", contentType = "section") {
                SectionHeader(section, enabled = !searching, onToggle = { onToggleSection(section.id) },
                    onNewInDirectory = onNewInDirectory)
            }
            if (!section.collapsed) {
                items(section.rows, key = { "session:${it.id}" }, contentType = { "session" }) { row ->
                    SessionRow(row, onOpen = onOpen, onLongPress = onLongPress)
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(
    section: SessionSectionUi,
    enabled: Boolean,
    onToggle: () -> Unit,
    onNewInDirectory: ((String?, String) -> Unit)?,
) {
    val title = when (section.kind) {
        SessionSectionKind.PINNED -> stringResource(R.string.sessions_section_pinned)
        SessionSectionKind.IN_PROGRESS -> stringResource(R.string.sessions_section_in_progress)
        SessionSectionKind.ACTIVE -> stringResource(R.string.sessions_section_active)
        SessionSectionKind.WORKSPACE -> section.title ?: stringResource(R.string.sessions_section_other_workspace)
    }
    val expansion = stringResource(if (section.collapsed) R.string.sessions_group_collapsed else R.string.sessions_group_expanded)
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f)
                .clickable(enabled = enabled, role = Role.Button, onClick = onToggle)
                .semantics { stateDescription = expansion }
                .heightIn(min = 48.dp)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                if (section.collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                section.machine?.let { machine ->
                    Text(machineFilterLabel(machine), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (section.rows.any { it.unread }) UnreadDot()
            Text(section.rows.size.toString(), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val directory = section.directory?.takeIf { section.kind == SessionSectionKind.WORKSPACE && it.isNotEmpty() }
        if (directory != null && onNewInDirectory != null) {
            IconButton(
                onClick = { onNewInDirectory(section.machineId, directory) },
                modifier = Modifier.padding(end = 8.dp),
            ) {
                Icon(Icons.Default.Add, contentDescription = stringResource(R.string.sessions_new_in_workspace, title))
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    row: SessionRowUi,
    onOpen: (String) -> Unit,
    onLongPress: (SessionRowUi) -> Unit,
) {
    val summary = row.summary
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = { onOpen(row.id) },
                onLongClick = { onLongPress(row) },
            )
            // 8dp keeps the old content-to-gap rhythm: rows shrank from three
            // text lines to two, and the unchanged 10dp read as oversized
            // gaps between the now-shorter items (device feedback).
            .padding(horizontal = 16.dp, vertical = 8.dp)
            // Dimming expresses "disconnected" (web parity): connected is the
            // resting state here, so only the exception gets marked — no
            // per-row presence dot.
            .alpha(if (summary.active) 1f else 0.5f),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AgentFlavorIcon(row.flavor, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(6.dp))
            // One weighted element only: the title takes ALL leftover
            // width (start-aligned, ellipsis on true overflow). Splitting
            // the slack with a weighted trailing spacer truncated even
            // short names at ~half the row (device-observed).
            Text(
                text = row.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (row.unread) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (summary.active && summary.thinking) {
                Spacer(modifier = Modifier.width(6.dp))
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 1.5.dp,
                    color = Color(0xFF34C759),
                )
            }
            if (row.unread) {
                Spacer(modifier = Modifier.width(6.dp))
                UnreadDot()
            }
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = localizedRelativeAge(summary.updatedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // Summary directly under the title (its prose continuation); the
        // `project · machine` meta closes the row as a footer.
        row.subtitle?.let { subtitle ->
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        MetaLine(row)
        BadgeLine(summary)
    }
}

// `project · worktree · machine`, composed in the ViewModel (machine only
// when it disambiguates) — the row just renders it.
@Composable
private fun MetaLine(row: SessionRowUi) {
    val meta = listOfNotNull(row.meta, row.machine?.let { machineFilterLabel(it) }).joinToString(" · ").takeIf { it.isNotEmpty() } ?: return
    Text(
        text = meta,
        // bodySmall, not labelSmall: as the row's only secondary line the
        // meta carries the project scan key — label tracking (0.5sp at 11sp)
        // reads stringy on path-like text (web parity: title 14 / meta 12).
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun BadgeLine(summary: SessionSummary) {
    val hasPending = summary.pendingRequestsCount > 0
    val todoProgress = summary.todoProgress
    if (!hasPending && todoProgress == null) return
    Row(
        modifier = Modifier.padding(top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (hasPending) {
            PendingBadge(
                count = summary.pendingRequestsCount,
                kinds = summary.pendingRequestKinds,
                requests = summary.pendingRequests,
            )
        }
        todoProgress?.let { TodoChip(it) }
    }
}

/**
 * Pending badge: authoritative `pendingRequestsCount` + kind wording; the
 * capped `pendingRequests` slice names the first tool.
 */
@Composable
private fun PendingBadge(count: Int, kinds: List<String>, requests: List<PendingRequest>) {
    val needsInput = kinds.contains("input") && !kinds.contains("permission")
    val label = when {
        needsInput -> stringResource(R.string.sessions_badge_needs_input)
        requests.isNotEmpty() -> stringResource(R.string.sessions_badge_approve, requests.first().tool)
        else -> stringResource(R.string.sessions_badge_pending)
    }
    val text = if (count > 1) "$count · $label" else label
    Surface(
        color = MaterialTheme.colorScheme.tertiaryContainer,
        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        shape = RoundedCornerShape(6.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun TodoChip(progress: TodoProgress) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        shape = RoundedCornerShape(6.dp),
    ) {
        Text(
            text = "☑ ${progress.completed}/${progress.total}",
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun UnreadDot() {
    Box(
        modifier = Modifier
            .size(8.dp)
            .background(MaterialTheme.colorScheme.primary, CircleShape),
    )
}

// --------------------------------------------------------------- chrome --

@Composable
private fun OfflineBanner() {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = stringResource(R.string.sessions_offline_banner),
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun EmptyState(hasLoaded: Boolean, isOffline: Boolean) {
    // verticalScroll keeps the pull-to-refresh gesture available even though
    // there is nothing to scroll.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(
                when {
                    !hasLoaded && !isOffline -> R.string.sessions_empty_loading_title
                    isOffline -> R.string.sessions_empty_offline_title
                    else -> R.string.sessions_empty_title
                },
            ),
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(
                when {
                    !hasLoaded && !isOffline -> R.string.sessions_empty_loading_hint
                    isOffline -> R.string.sessions_empty_offline_hint
                    else -> R.string.sessions_empty_hint
                },
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionActionsSheet(
    row: SessionRowUi, onDismiss: () -> Unit, onSetPinMode: (PinMode) -> Unit,
    onArchive: () -> Unit, onRename: () -> Unit, onReopen: () -> Unit, onDelete: () -> Unit,
    onUnread: () -> Unit, onNewInDirectory: (() -> Unit)?,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(row.title, modifier = Modifier.padding(16.dp), maxLines = 2)
        SessionActionItems(row.id, row.title, row.summary.active, row.summary.pinned == true, row.summary.globalPinned == true,
            onDismiss, onRename, onSetPinMode, onUnread, onArchive, onReopen, onDelete, onNewInDirectory)
    }
}

@Composable
private fun SheetAction(text: String, destructive: Boolean = false, onClick: () -> Unit) {
    ListItem(
        headlineContent = {
            Text(
                text = text,
                color = if (destructive) MaterialTheme.colorScheme.error else Color.Unspecified,
            )
        },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

// -------------------------------------------------------------- preview --

private fun previewRow(
    id: String,
    title: String,
    active: Boolean = false,
    thinking: Boolean = false,
    unread: Boolean = false,
    pinned: Boolean = false,
    pending: Int = 0,
    todo: TodoProgress? = null,
): SessionRowUi = SessionRowUi(
    summary = SessionSummary(
        id = id,
        active = active,
        thinking = thinking,
        activeAt = 0,
        updatedAt = System.currentTimeMillis() - 300_000,
        pinned = pinned,
        metadata = SessionSummaryMetadata(
            path = "/data/github/hapi",
            flavor = "claude",
            summary = SummaryText("Porting the session list to Compose"),
        ),
        todoProgress = todo,
        pendingRequestsCount = pending,
        pendingRequestKinds = if (pending > 0) listOf("permission") else emptyList(),
        pendingRequests = if (pending > 0) {
            listOf(PendingRequest(id = "r1", kind = "permission", tool = "Bash", since = 0))
        } else {
            emptyList()
        },
    ),
    title = title,
    subtitle = "Porting the session list to Compose",
    meta = "github/hapi · devbox",
    flavor = "claude",
    unread = unread,
)

@Preview(showBackground = true)
@Composable
private fun SessionRowsPreview() {
    HapiTheme {
        Surface {
            SessionRows(
                sections = buildSessionSections(listOf(
                    previewRow("s1", "Pinned build fix", pinned = true),
                    previewRow("s2", "Session list UI", active = true, thinking = true, unread = true, todo = TodoProgress(3, 5)),
                    previewRow("s3", "Fixture sweep", active = true, pending = 2),
                    previewRow("s4", "Old research"),
                )),
                searching = false,
                onToggleSection = {},
                onOpen = {},
                onLongPress = {},
                onNewInDirectory = { _, _ -> },
            )
        }
    }
}
