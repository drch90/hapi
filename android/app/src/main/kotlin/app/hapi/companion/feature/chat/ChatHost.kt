package app.hapi.companion.feature.chat

import android.net.Uri
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.NavType
import androidx.navigation.compose.*
import androidx.navigation.navArgument
import app.hapi.companion.R
import app.hapi.companion.ui.components.FullTextAction
import app.hapi.companion.feature.chat.blocks.*
import app.hapi.companion.feature.chat.composer.DictationController
import app.hapi.companion.ui.markdown.LocalMarkdownLinkHandler
import app.hapi.companion.ui.markdown.LocalMarkdownRenderCache
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.companion.ui.theme.ReadingColumn
import app.hapi.protocol.chat.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Session lifetime surrounds native navigation. The holder stops the pipe on exit,
 * not when a recycled row, a covered destination, or an activity leaves composition. */
@Composable
internal fun ChatHost(
    viewModel: ChatViewModel,
    media: ChatMedia,
    onBack: () -> Unit,
    onNavigateToSession: (String) -> Unit,
    dictation: DictationController?,
    onOpenFiles: () -> Unit,
    onOpenReference: (String) -> Unit = onNavigateToSession,
    onNewInDirectory: ((String?, String) -> Unit)? = null,
    onOpenFile: (String, Int?) -> Unit,
    onOpenScratchlist: (() -> Unit)?,
) {
    val navigation = rememberNavController()
    val entry by navigation.currentBackStackEntryAsState()
    val reading = rememberTranscriptReadingState(viewModel.sessionId)
    val transcriptList = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    val state by viewModel.uiState.collectAsState()
    val reset by viewModel.inspection.reset.collectAsState()
    var handledReset by rememberSaveable(viewModel.sessionId) { mutableLongStateOf(0L) }
    val latestDictation by rememberUpdatedState(dictation)
    val latestKeyboard by rememberUpdatedState(keyboard)
    val latestBack by rememberUpdatedState(onBack)
    val latestNavigate by rememberUpdatedState(onNavigateToSession)
    val latestReference by rememberUpdatedState(onOpenReference)
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val fileComposerReturnPending by viewModel.fileComposerReturnPending.collectAsState()

    LaunchedEffect(fileComposerReturnPending, lifecycleState, entry?.destination?.route) {
        if (!fileComposerReturnPending || lifecycleState != Lifecycle.State.RESUMED) return@LaunchedEffect
        // A file can also be opened from a tool inspector. Return to the
        // conversation before issuing a fresh focus request to the editor.
        if (entry?.destination?.route != "thread") {
            navigation.popBackStack("thread", false)
            return@LaunchedEffect
        }
        withFrameNanos { }
        viewModel.completeFileComposerReturn()
    }

    // Keep session events alive while any inspector is covering the conversation.
    LaunchedEffect(viewModel, context) {
        viewModel.events.collect { event ->
            when (event) {
                is ChatEvent.OpenReference -> latestReference(event.sessionId)
                is ChatEvent.SessionSuperseded -> latestNavigate(event.sessionId)
                ChatEvent.SessionDeleted -> latestBack()
                is ChatEvent.Notice -> launch { snackbar.showSnackbar(chatNoticeText(context, event.notice)) }
            }
        }
    }

    fun pauseReading() {
        reading.followsTail = false
        viewModel.beginInspection()
        latestDictation?.cancel()
        latestKeyboard?.hide()
    }
    val actions = remember(viewModel, navigation, reading) {
        object : ChatInspectionActions {
            override fun openTool(id: String) {
                pauseReading()
                viewModel.inspection.retainTool(id)
                val process = viewModel.inspection.tool(id)?.value?.let(::opensToolProcess) == true
                navigation.navigate("${if (process) "process" else "tool"}/${Uri.encode(id)}")
            }
            override fun openGroup(id: String) {
                pauseReading()
                viewModel.inspection.retainGroup(id)
                navigation.navigate("group/${Uri.encode(id)}")
            }
            override fun openMessage(id: String) {
                pauseReading()
                viewModel.inspection.retainMessage(id)
                navigation.navigate("message/${Uri.encode(id)}")
            }
        }
    }
    DisposableEffect(viewModel) {
        viewModel.start()
        onDispose { viewModel.setTranscriptVisible(false) }
    }
    LaunchedEffect(entry?.destination?.route) {
        if (entry?.destination?.route == "thread") viewModel.inspection.clearSelections()
    }
    LaunchedEffect(reset) {
        // Consume each epoch reset once. Recreation must not dismiss a new
        // inspector merely because this session had an earlier reset.
        if (reset > handledReset) navigation.popBackStack("thread", false)
        handledReset = reset
    }
    val interactions = remember(state.flavor, state.permissionOverrides, viewModel) {
        ChatInteractions(state.flavor, state.permissionOverrides, viewModel::resolvePermission, viewModel::retryFailedMessage)
    }
    val openFile: (String, Int?) -> Unit = { path, line -> pauseReading(); onOpenFile(path, line) }
    app.hapi.companion.feature.chat.media.ChatImageGallery(state.blocks, media) {
        CompositionLocalProvider(
            LocalChatInspection provides actions,
            LocalChatInteractions provides interactions,
            LocalChatMedia provides media,
            LocalMarkdownRenderCache provides viewModel.markdownCache,
            LocalMarkdownLinkHandler provides rememberChatLinkHandler(
                onOpenFile = openFile, onOpenSession = viewModel::openReference, workspacePath = state.basePath,
            ),
        ) {
            Box(Modifier.fillMaxSize()) {
                NavHost(navigation, startDestination = "thread") {
                    composable("thread") {
                        ChatScreen(
                            viewModel, media, onBack, snackbarHostState = snackbar,
                            dictation = dictation, onOpenFiles = { pauseReading(); onOpenFiles() }, onOpenFile = openFile,
                            onOpenScratchlist = onOpenScratchlist?.let { open -> { pauseReading(); open() } },
                            onNewInDirectory = onNewInDirectory,
                            transcriptList = transcriptList, readingState = reading,
                        )
                    }
                    for (kind in listOf("group", "tool", "process", "message")) {
                        composable("$kind/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { destination ->
                            val id = destination.arguments?.getString("id").orEmpty()
                            val revision by viewModel.inspection.revision.collectAsState()
                            val back = { navigation.popBackStack(); Unit }
                            val close = { navigation.popBackStack("thread", false); Unit }
                            when (kind) {
                                "group" -> {
                                    val group = remember(id, revision) { viewModel.inspection.group(id) }
                                    if (group == null) MissingInspection(back, close)
                                    else ToolGroupBrowser(group, state.basePath, openFile, back, close)
                                }
                                "message" -> {
                                    val message = remember(id, revision) { viewModel.inspection.message(id) }
                                    if (message == null) MissingInspection(back, close)
                                    else MessageReader(message.value.text, message.stale, back, close)
                                }
                                else -> {
                                    val tool = remember(id, revision) { viewModel.inspection.tool(id) }
                                    if (tool == null) MissingInspection(back, close)
                                    else ToolReader(tool, kind == "process", state.basePath, openFile, back, close)
                                }
                            }
                        }
                    }
                }
                if (entry?.destination?.route != "thread") {
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InspectionScaffold(
    title: String, back: () -> Unit, close: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.chat_back)) } },
                actions = {
                    actions()
                    IconButton(onClick = close, modifier = Modifier.testTag("inspection-close")) {
                        Icon(Icons.Default.Close, stringResource(R.string.chat_close_reader))
                    }
                },
            )
        }, bottomBar = bottomBar, content = content,
    )
}

@Composable
private fun InspectionNotice(stale: Boolean, incomplete: Boolean = false) {
    if (stale || incomplete) Text(
        stringResource(if (stale) R.string.chat_snapshot_notice else R.string.chat_group_history_notice),
        style = HapiTypography.caption, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = 8.dp).testTag("inspection-notice"),
    )
}

@Composable
private fun MissingInspection(back: () -> Unit, close: () -> Unit) {
    InspectionScaffold(stringResource(R.string.chat_tool_details), back, close) { padding ->
        Text(stringResource(R.string.chat_content_unavailable), modifier = Modifier.padding(padding).padding(16.dp))
    }
}

@Composable
internal fun ToolGroupBrowser(
    inspected: Inspected<ToolGroupBlock>, basePath: String?, openFile: (String, Int?) -> Unit,
    back: () -> Unit, close: () -> Unit,
) {
    val group = inspected.value
    val rows = inspectionTimeline(group.tools)
    val list = rememberLazyListState(initialFirstVisibleItemIndex = rows.lastIndex.coerceAtLeast(0))
    val interactions = LocalChatInteractions.current.takeUnless { inspected.stale }
    val currentGroup by rememberUpdatedState(group)
    val currentRows by rememberUpdatedState(rows)
    var revealFor by remember { mutableStateOf<ToolGroupBlock?>(group) }
    var geometryRevision by remember { mutableIntStateOf(0) }
    var revealing by remember { mutableStateOf(false) }
    val heights = remember { mutableMapOf<String, Int>() }
    LaunchedEffect(group) {
        // Only settle the content that was present at navigation time. A live
        // update must preserve reading position, rather than follow new tools.
        if (revealFor !== group) revealFor = null
        heights.keys.retainAll(rows.mapTo(mutableSetOf()) { it.id })
    }
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to revealing }.collect { (scrolling, ownScroll) ->
            if (scrolling && !ownScroll) revealFor = null
        }
    }
    LaunchedEffect(list) {
        snapshotFlow {
            val request = revealFor
            if (request == null || request !== currentGroup || list.isScrollInProgress) null
            else Triple(request, geometryRevision, list.layoutInfo.totalItemsCount)
        }.collect { report ->
            if (report == null) return@collect
            // Expanded inputs/results finish measuring asynchronously. Keep
            // this explicit destination visible as those bodies replace their
            // loading placeholders, without scrolling from a layout callback.
            withContext(Dispatchers.Main) {
                if (revealFor !== report.first || currentGroup !== report.first || list.isScrollInProgress) return@withContext
                val current = currentRows
                val info = list.layoutInfo
                if (current.isEmpty() || info.totalItemsCount != current.size) return@withContext
                val target = info.visibleItemsInfo.firstOrNull { it.key == current.last().id }
                val viewportHeight = info.viewportEndOffset - info.viewportStartOffset
                if (target != null && target.offset >= info.viewportStartOffset &&
                    target.offset + minOf(target.size, viewportHeight) <= info.viewportEndOffset) return@withContext
                revealing = true
                try { list.scrollToItem(current.lastIndex) } finally { revealing = false }
            }
        }
    }
    InspectionScaffold(stringResource(R.string.chat_group_tools_many, group.summary.totalTools), back, close,
        actions = {
            IconButton(onClick = { revealFor = currentGroup; geometryRevision++ },
                modifier = Modifier.testTag("inspection-latest-tool")) {
                Icon(Icons.Default.KeyboardArrowDown, stringResource(R.string.chat_latest_tool))
            }
        },
    ) { padding ->
        ReadingColumn(Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                InspectionNotice(inspected.stale, group.needsOlderHistory)
                LazyColumn(
                    state = list,
                    modifier = Modifier.weight(1f).fillMaxWidth().testTag("inspection-tools").pointerInput(list) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            revealFor = null
                        }
                    },
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(rows, key = { it.id }, contentType = { it.kind }) { block ->
                        CompositionLocalProvider(LocalChatInteractions provides interactions) {
                            InspectionBlock(block, basePath, openFile, Modifier.testTag("inspection-tool-${block.id}").onSizeChanged {
                                if (list.isScrollInProgress && !revealing) revealFor = null
                                if (heights.put(block.id, it.height) != it.height) geometryRevision++
                            })
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun MessageReader(text: String, stale: Boolean, back: () -> Unit, close: () -> Unit) {
    var starts by rememberSaveable { mutableStateOf(listOf(0)) }
    val start = starts.last().coerceAtMost(text.length)
    val page = remember(text, start) { readTextPage(text, start) }
    val scroll = rememberScrollState()
    LaunchedEffect(start) { scroll.scrollTo(0) }
    InspectionScaffold(stringResource(R.string.chat_full_message), back, close,
        actions = { FullTextAction(text, compact = true) },
        bottomBar = {
            ReadingColumn(Modifier.navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { starts = starts.dropLast(1) }, enabled = starts.size > 1,
                        modifier = Modifier.weight(1f).testTag("reader-previous")) { Text(stringResource(R.string.chat_previous_part)) }
                    TextButton(onClick = {}, enabled = false, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.chat_part_number, starts.size)) }
                    TextButton(onClick = { starts = starts + page.end }, enabled = page.end < text.length,
                        modifier = Modifier.weight(1f).testTag("reader-next")) { Text(stringResource(R.string.chat_next_part)) }
                }
            }
        },
    ) { padding ->
        ReadingColumn(Modifier.padding(padding).fillMaxSize().verticalScroll(scroll)) {
            Column(Modifier.padding(vertical = 16.dp)) {
                InspectionNotice(stale)
                SelectionContainer { Text(page.text, style = HapiTypography.body, modifier = Modifier.testTag("reader-text")) }
            }
        }
    }
}

@Composable
internal fun ToolReader(
    inspected: Inspected<ToolCallBlock>, process: Boolean, basePath: String?,
    openFile: (String, Int?) -> Unit, back: () -> Unit, close: () -> Unit,
) {
    val block = inspected.value
    val rows = if (process) inspectionTimeline(listOf(block)) else listOf(block)
    val interactions = LocalChatInteractions.current.takeUnless { inspected.stale }
    InspectionScaffold(stringResource(if (process) R.string.chat_agent_process else R.string.chat_tool_details), back, close) { padding ->
        ReadingColumn(Modifier.padding(padding)) {
            LazyColumn(Modifier.fillMaxSize().testTag("inspection-detail"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                item("notice") { InspectionNotice(inspected.stale) }
                items(rows, key = { it.id }, contentType = { it.kind }) { row ->
                    CompositionLocalProvider(LocalChatInteractions provides interactions) {
                        InspectionBlock(row, basePath, openFile, Modifier.testTag("inspection-tool-${row.id}"))
                    }
                }
            }
        }
    }
}

@Composable
private fun InspectionBlock(block: ChatBlock, basePath: String?, openFile: (String, Int?) -> Unit, modifier: Modifier) {
    if (block is ToolCallBlock) {
        ToolCallBlockView(block, basePath, modifier, expandedDetails = true, onOpenFile = openFile)
    } else {
        ChatBlockCard(block, basePath, modifier)
    }
}
