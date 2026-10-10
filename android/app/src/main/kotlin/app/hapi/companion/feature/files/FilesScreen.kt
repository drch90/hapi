package app.hapi.companion.feature.files

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.git.GitFileStatus
import app.hapi.protocol.wire.FileSearchItem

/**
 * Session files browser (`chat/{sessionId}/files`), the Android take on web
 * `files.tsx`: **Changes** (branch header + staged/unstaged sections with
 * status letters and ±counts), **Browse** (lazily expanded directory tree,
 * dirs-first sort, hidden-file toggle), **Search** (debounced ripgrep query).
 * Rows open the file viewer — Changes rows carry their staged side so the
 * viewer opens on the right diff.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(
    viewModel: FilesViewModel,
    onBack: () -> Unit,
    onOpenFile: (path: String, staged: Boolean?) -> Unit,
    modifier: Modifier = Modifier,
    rootPath: String? = null,
    onSendToComposer: ((String) -> Unit)? = null,
) {
    DisposableEffect(viewModel) {
        viewModel.start()
        onDispose { }
    }

    val changes by viewModel.changes.collectAsState()
    val browse by viewModel.browse.collectAsState()
    val search by viewModel.search.collectAsState()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var pathTarget by remember(viewModel) { mutableStateOf<FilePathTarget?>(null) }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.files_back))
                    }
                },
                title = { Text(stringResource(R.string.files_title)) },
                actions = {
                    IconButton(
                        onClick = {
                            when (tab) {
                                0 -> viewModel.refreshChanges()
                                1 -> viewModel.refreshBrowse()
                                else -> viewModel.refreshSearch()
                            }
                        },
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.files_refresh))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            FilePathBar(rootPath ?: ".") { pathTarget = FilePathTarget(rootPath ?: ".", isDirectory = true) }
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.files_tab_changes)) })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.files_tab_browse)) })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text(stringResource(R.string.files_tab_search)) })
            }
            when (tab) {
                0 -> ChangesTab(changes, onOpenFile, onPathActions = { pathTarget = FilePathTarget(it) })
                1 -> BrowseTab(
                    browse,
                    onToggleDirectory = viewModel::toggleDirectory,
                    onToggleHidden = viewModel::setShowHidden,
                    onOpenFile = { path -> onOpenFile(path, null) },
                    onPathActions = { pathTarget = it },
                )
                else -> SearchTab(
                    search,
                    onQueryChange = viewModel::setSearchQuery,
                    onOpenFile = { path -> onOpenFile(path, null) },
                    onPathActions = { pathTarget = FilePathTarget(it) },
                )
            }
        }
    }
    pathTarget?.let { target ->
        FilePathActionsSheet(target, onDismiss = { pathTarget = null }, onSendToComposer = onSendToComposer)
    }
}

// ------------------------------------------------------------ Changes tab --

@Composable
private fun ChangesTab(
    state: ChangesUiState,
    onOpenFile: (path: String, staged: Boolean?) -> Unit,
    onPathActions: (String) -> Unit,
) {
    val colors = MaterialTheme.hapi

    Column(modifier = Modifier.fillMaxSize()) {
        state.error?.let { ErrorBanner(it) }

        when {
            state.loading && state.status == null -> CenteredProgress()
            state.status == null -> CenteredHint(stringResource(R.string.files_git_unavailable))
            else -> {
                val status = state.status

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(
                        GitBranchGlyph,
                        contentDescription = null,
                        tint = colors.hint,
                        modifier = Modifier.size(16.dp),
                    )
                    Column {
                        Text(
                            text = status.branch ?: stringResource(R.string.files_detached_head),
                            fontWeight = FontWeight.SemiBold,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            text = stringResource(
                                R.string.files_staged_unstaged,
                                status.totalStaged,
                                status.totalUnstaged,
                            ),
                            fontSize = 12.sp,
                            color = colors.hint,
                        )
                    }
                }

                if (status.stagedFiles.isEmpty() && status.unstagedFiles.isEmpty()) {
                    CenteredHint(stringResource(R.string.files_no_changes))
                } else {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        if (status.stagedFiles.isNotEmpty()) {
                            item(key = "staged-header") {
                                SectionHeader(stringResource(R.string.files_staged_header, status.stagedFiles.size))
                            }
                            items(
                                status.stagedFiles.size,
                                key = { "staged-${status.stagedFiles[it].fullPath}-$it" },
                            ) { index ->
                                val file = status.stagedFiles[index]
                                GitFileRow(file, onClick = { onOpenFile(file.fullPath, true) },
                                    onLongClick = { onPathActions(file.fullPath) })
                            }
                        }
                        if (status.unstagedFiles.isNotEmpty()) {
                            item(key = "unstaged-header") {
                                SectionHeader(stringResource(R.string.files_unstaged_header, status.unstagedFiles.size))
                            }
                            items(
                                status.unstagedFiles.size,
                                key = { "unstaged-${status.unstagedFiles[it].fullPath}-$it" },
                            ) { index ->
                                val file = status.unstagedFiles[index]
                                GitFileRow(file, onClick = { onOpenFile(file.fullPath, false) },
                                    onLongClick = { onPathActions(file.fullPath) })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.hapi.hint,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.hapi.codeHeaderBackground)
            .padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun GitFileRow(file: GitFileStatus, onClick: () -> Unit, onLongClick: () -> Unit) {
    val colors = MaterialTheme.hapi

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick,
                onLongClickLabel = stringResource(R.string.files_path_actions))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = file.fileName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val subtitle = file.oldPath?.let { "$it → ${file.fullPath}" }
                ?: file.filePath.ifEmpty { stringResource(R.string.files_project_root) }
            Text(
                text = subtitle,
                fontSize = 12.sp,
                color = colors.hint,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
        if (file.linesAdded > 0 || file.linesRemoved > 0) {
            Text(
                text = buildString {
                    if (file.linesAdded > 0) append("+${file.linesAdded}")
                    if (file.linesAdded > 0 && file.linesRemoved > 0) append(' ')
                    if (file.linesRemoved > 0) append("-${file.linesRemoved}")
                },
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = colors.hint,
            )
        }
        StatusBadge(file)
    }
}

@Composable
private fun StatusBadge(file: GitFileStatus) {
    val color = statusColor(file.status, MaterialTheme.hapi.isDark)
    Text(
        text = statusLetter(file.status),
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        color = color,
        modifier = Modifier
            .border(1.dp, color, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

// ------------------------------------------------------------- Browse tab --

@Composable
private fun BrowseTab(
    state: BrowseUiState,
    onToggleDirectory: (String) -> Unit,
    onToggleHidden: (Boolean) -> Unit,
    onOpenFile: (path: String) -> Unit,
    onPathActions: (FilePathTarget) -> Unit,
) {
    val colors = MaterialTheme.hapi

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onToggleHidden(!state.showHidden) }
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = state.showHidden, onCheckedChange = onToggleHidden)
            Text(stringResource(R.string.files_show_hidden), fontSize = 13.sp, color = colors.hint)
        }

        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(state.rows.size) { index ->
                when (val row = state.rows[index]) {
                    is BrowseRow.Dir -> DirectoryRow(row, onToggleDirectory,
                        onLongClick = { onPathActions(FilePathTarget(row.path, isDirectory = true)) })
                    is BrowseRow.File -> FileRow(row, onOpenFile,
                        onLongClick = { onPathActions(FilePathTarget(row.path)) })
                    is BrowseRow.Loading -> Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = rowIndent(row.depth) + 16.dp, top = 10.dp, bottom = 10.dp),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    }
                    is BrowseRow.Error -> Text(
                        text = row.message,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = rowIndent(row.depth) + 16.dp, top = 8.dp, bottom = 8.dp, end = 16.dp),
                    )
                }
            }
        }
    }
}

private fun rowIndent(depth: Int) = (depth * 16).dp

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DirectoryRow(row: BrowseRow.Dir, onToggle: (String) -> Unit, onLongClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = { onToggle(row.path) }, onLongClick = onLongClick,
                onLongClickLabel = stringResource(R.string.files_path_actions))
            .padding(start = rowIndent(row.depth) + 8.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            if (row.expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = stringResource(if (row.expanded) R.string.files_collapse else R.string.files_expand),
            tint = MaterialTheme.hapi.hint,
            modifier = Modifier.size(18.dp),
        )
        Icon(
            FolderGlyph,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(18.dp),
        )
        Text(
            text = row.name,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FileRow(row: BrowseRow.File, onOpenFile: (String) -> Unit, onLongClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = { onOpenFile(row.path) }, onLongClick = onLongClick,
                onLongClickLabel = stringResource(R.string.files_path_actions))
            // Files align with sibling directory names (chevron width offset).
            .padding(start = rowIndent(row.depth) + 30.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            formatFileMetadata(row.size, row.modified)?.let {
                Text(text = it, fontSize = 11.sp, color = MaterialTheme.hapi.hint)
            }
        }
    }
}

// ------------------------------------------------------------- Search tab --

@Composable
private fun SearchTab(
    state: SearchUiState,
    onQueryChange: (String) -> Unit,
    onOpenFile: (path: String) -> Unit,
    onPathActions: (String) -> Unit,
) {
    val colors = MaterialTheme.hapi

    Column(modifier = Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = state.query,
            onValueChange = onQueryChange,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            placeholder = { Text(stringResource(R.string.files_search_placeholder)) },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            singleLine = true,
        )

        when {
            state.query.isBlank() -> CenteredHint(stringResource(R.string.files_search_hint))
            state.loading -> CenteredProgress()
            state.error != null -> ErrorBanner(state.error)
            state.searched && state.results.isEmpty() -> CenteredHint(stringResource(R.string.files_search_no_match))
            else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(state.results, key = { it.fullPath }) { item ->
                    SearchResultRow(item, onClick = { onOpenFile(item.fullPath) },
                        onLongClick = { onPathActions(item.fullPath) })
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SearchResultRow(item: FileSearchItem, onClick: () -> Unit, onLongClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick,
                onLongClickLabel = stringResource(R.string.files_path_actions))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = item.fullPath,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            formatFileMetadata(item.size, item.modified)?.let {
                Text(text = it, fontSize = 11.sp, color = MaterialTheme.hapi.hint)
            }
        }
    }
}

// ------------------------------------------------------------------ misc --

@Composable
private fun ErrorBanner(message: String) {
    Text(
        text = message,
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun CenteredProgress() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun CenteredHint(text: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, fontSize = 13.sp, color = MaterialTheme.hapi.hint)
    }
}
