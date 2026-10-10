package app.hapi.companion.feature.chat

import app.hapi.companion.feature.sessions.SessionActionItems
import app.hapi.companion.feature.sessions.ArchiveSessionDialog
import app.hapi.companion.feature.sessions.PinMode
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import android.content.Context
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import app.hapi.companion.R
import app.hapi.companion.feature.chat.composer.DictationErrorKind
import app.hapi.companion.feature.chat.attachments.AttachmentPickerSheet
import app.hapi.companion.feature.chat.attachments.AttachmentPreparer
import app.hapi.companion.feature.chat.attachments.CameraCapture
import app.hapi.companion.feature.chat.attachments.PrepareResult
import app.hapi.companion.feature.chat.composer.ChatComposer
import app.hapi.companion.feature.chat.composer.DictationController
import app.hapi.companion.feature.chat.composer.DictationEvent
import app.hapi.companion.feature.chat.composer.DictationState
import app.hapi.companion.feature.chat.composer.QueuedMessagesBar
import app.hapi.companion.feature.files.FolderGlyph
import app.hapi.companion.feature.sessions.DeleteSessionDialog
import app.hapi.companion.feature.sessions.RenameSessionDialog
import app.hapi.companion.ui.markdown.LocalMarkdownRenderCache
import app.hapi.companion.ui.markdown.LocalMarkdownLinkHandler
import app.hapi.companion.ui.theme.hapi
import java.io.File
import kotlinx.coroutines.launch

/** Pending camera capture across rotation/process death: uri + scratch path. */
private val CameraCaptureSaver = listSaver<CameraCapture?, String>(
    save = { capture ->
        if (capture == null) emptyList() else listOf(capture.uri.toString(), capture.file.absolutePath)
    },
    restore = { saved ->
        if (saved.size < 2) null else CameraCapture(Uri.parse(saved[0]), File(saved[1]))
    },
)

/** Conversation destination. ChatHost owns the shared session and reader navigation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatScreen(
    viewModel: ChatViewModel,
    media: ChatMedia,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    snackbarHostState: SnackbarHostState = remember { SnackbarHostState() },
    /** null ⇒ mic button hidden (tests / previews without a controller). */
    dictation: DictationController? = null,
    /** Top-bar folder icon → session files browser (B-M4c). */
    onOpenFiles: () -> Unit = {},
    onNewInDirectory: ((String?, String) -> Unit)? = null,
    /** Markdown file citations → file viewer (full mode; optional line hint). */
    onOpenFile: (path: String, line: Int?) -> Unit = { _, _ -> },
    /** null ⇒ no scratchlist top-bar entry (tests / previews). */
    onOpenScratchlist: (() -> Unit)? = null,
    transcriptList: androidx.compose.foundation.lazy.LazyListState = androidx.compose.foundation.lazy.rememberLazyListState(),
    readingState: TranscriptReadingState = rememberTranscriptReadingState(viewModel.sessionId),
) {
    val state by viewModel.uiState.collectAsState()
    val reconnecting by viewModel.reconnecting.collectAsState()
    val historyPaging by viewModel.historyPaging.collectAsState()
    val jumpToken by viewModel.jumpToken.collectAsState()
    val jumpingLatest by viewModel.jumpingLatest.collectAsState()
    val composerState by viewModel.composer.collectAsState()
    val agentStatus by viewModel.agentStatus.collectAsState()
    val contextUsage by viewModel.contextUsage.collectAsState()
    val codexPlanActions by viewModel.codexPlanActions.collectAsState()
    val queuedRows by viewModel.queuedRows.collectAsState()
    val configState by viewModel.config.collectAsState()
    val toolbarHeight = maxOf(64.dp, with(LocalDensity.current) { 24.sp.toDp() + 16.sp.toDp() } + 16.dp)
    var configSheetOpen by remember { mutableStateOf(false) }
    var archiveDialogOpen by remember { mutableStateOf(false) }
    var outlineOpen by remember { mutableStateOf(false) }
    var outlineItems by remember { mutableStateOf(emptyList<OutlineItem>()) }
    var location by remember { mutableStateOf<Pair<String, Long>?>(null) }
    DisposableEffect(outlineOpen) {
        if (outlineOpen) { readingState.followsTail = false; viewModel.beginInspection() }
        onDispose { if (outlineOpen) viewModel.setTranscriptVisible(true) }
    }
    LaunchedEffect(jumpToken) { outlineOpen = false; location = null }
    val sendSchedule by viewModel.schedule.collectAsState()
    val actionSummary by viewModel.actionSummary.collectAsState()
    val allSessions by viewModel.allSessions.collectAsState()
    val machines by viewModel.machines.collectAsState()
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, viewModel) {
        val observer = LifecycleEventObserver { _, _ -> viewModel.setReaderForeground(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
        lifecycleOwner.lifecycle.addObserver(observer)
        viewModel.setReaderForeground(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer); viewModel.setReaderForeground(false) }
    }
    var renameDialogOpen by remember { mutableStateOf(false) }
    var deleteDialogOpen by remember { mutableStateOf(false) }

    DisposableEffect(viewModel) {
        viewModel.setTranscriptVisible(true)
        onDispose { viewModel.setTranscriptVisible(false) }
    }

    val context = LocalContext.current
    // ------------------------------------------------------------ dictation --
    val dictationState = dictation?.state?.collectAsState()?.value ?: DictationState.Idle
    val dictationAvailable = dictation?.isAvailable?.collectAsState()?.value ?: false
    LaunchedEffect(dictation) {
        dictation?.refreshAvailability()
    }
    LaunchedEffect(dictation, context) {
        dictation?.events?.collect { event ->
            when (event) {
                is DictationEvent.Transcribed -> viewModel.appendDictatedText(event.text)
                DictationEvent.NoProvider -> snackbarHostState.showSnackbar(
                    context.getString(R.string.chat_notice_no_transcription),
                )
                is DictationEvent.Error -> snackbarHostState.showSnackbar(
                    event.detail ?: context.getString(
                        when (event.kind) {
                            DictationErrorKind.StartFailed -> R.string.chat_dictation_start_failed
                            DictationErrorKind.HubUnreachable -> R.string.chat_dictation_hub_unreachable
                            DictationErrorKind.RecordingFailed -> R.string.chat_dictation_recording_failed
                            DictationErrorKind.NoAudio -> R.string.chat_dictation_no_audio
                            DictationErrorKind.TranscriptionFailed -> R.string.chat_dictation_failed
                        },
                    ),
                )
            }
        }
    }
    val scope = rememberCoroutineScope()
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            dictation?.toggle()
        } else {
            scope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.chat_notice_mic_permission))
            }
        }
    }
    val onDictationToggle: () -> Unit = toggle@{
        val controller = dictation ?: return@toggle
        // Stopping never needs the permission; starting checks + requests it.
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        when {
            dictationState !is DictationState.Idle -> controller.toggle()
            granted -> controller.toggle()
            else -> micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    val slashSuggestions by viewModel.slashSuggestions.collectAsState()

    // --------------------------------------------------------- attachments --
    val attachmentItems by viewModel.attachments.items.collectAsState()
    var attachmentSheetOpen by remember { mutableStateOf(false) }
    val preparer = remember { AttachmentPreparer(context) }

    /** Read + policy-apply one pick, then hand it to the upload tray. */
    suspend fun ingestUri(uri: Uri) {
        when (val result = preparer.prepare(uri)) {
            is PrepareResult.Ready -> viewModel.attachments.add(result.attachment)
            is PrepareResult.TooLarge -> snackbarHostState.showSnackbar(
                context.getString(R.string.chat_notice_attachment_too_large, result.filename),
            )
            is PrepareResult.Unreadable -> snackbarHostState.showSnackbar(
                context.getString(R.string.chat_notice_attachment_unreadable, result.filename),
            )
        }
    }

    fun ingestUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch { uris.forEach { ingestUri(it) } }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris -> ingestUris(uris) }
    val documentPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> ingestUris(uris) }

    // The camera app may rotate/kill us while open — keep the scratch target.
    var pendingCapture by rememberSaveable(stateSaver = CameraCaptureSaver) {
        mutableStateOf<CameraCapture?>(null)
    }
    val takePictureLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        val capture = pendingCapture
        pendingCapture = null
        if (capture == null) return@rememberLauncherForActivityResult
        if (!success) {
            capture.discard()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            ingestUri(capture.uri)
            capture.discard()
        }
    }

    fun launchCamera() {
        val capture = preparer.newCameraCapture()
        pendingCapture = capture
        takePictureLauncher.launch(capture.uri)
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launchCamera()
        } else {
            scope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.chat_notice_camera_permission))
            }
        }
    }
    val onTakePhoto: () -> Unit = {
        // The manifest declares CAMERA (QR pairing), which makes the runtime
        // grant mandatory for ACTION_IMAGE_CAPTURE too.
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) launchCamera() else cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    val interactions = remember(state.flavor, state.permissionOverrides, codexPlanActions, viewModel) {
        ChatInteractions(
            flavor = state.flavor,
            permissionOverrides = state.permissionOverrides,
            resolvePermission = viewModel::resolvePermission,
            retryFailedMessage = viewModel::retryFailedMessage,
            codexPlanActions = codexPlanActions,
            implementCodexPlan = viewModel::implementCodexPlan,
            continueCodexPlan = viewModel::continueCodexPlan,
        )
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                expandedHeight = toolbarHeight,
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.chat_back))
                    }
                },
                title = { ChatTitle(state.header, reconnecting, viewModel::retry) },
                actions = {
                    // Two icons max (device feedback: four icons squeezed the
                    // title out) — gear for the frequent config switches,
                    // everything else in the overflow menu.
                    IconButton(onClick = { configSheetOpen = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.chat_open_settings))
                    }
                    val scratchlistCount by viewModel.scratchlistCount.collectAsState()
                    SessionOverflowMenu(
                        id = viewModel.sessionId, title = state.header.title,
                        pinned = actionSummary?.pinned == true, globalPinned = actionSummary?.globalPinned == true,
                        onPin = viewModel::setPinMode, onUnread = viewModel::markUnread,
                        onArchive = { archiveDialogOpen = true },
                        onOutline = { outlineItems = conversationOutline(state.blocks); outlineOpen = true },
                        onNewInDirectory = actionSummary?.metadata?.let { meta -> onNewInDirectory?.let { createSession ->
                            { createSession(meta.machineId, meta.worktree?.basePath ?: meta.path) }
                        } },
                        active = state.header.active,
                        onOpenFiles = onOpenFiles,
                        scratchlistCount = scratchlistCount,
                        onOpenScratchlist = if (viewModel.scratchlistEnabled) onOpenScratchlist else null,
                        onRename = { renameDialogOpen = true },
                        onReopen = viewModel::reopenSession,
                        onDelete = { deleteDialogOpen = true },
                        // Draft-level action, relocated from the composer's
                        // own overflow (one less button in the input bar).
                        onParkDraft = if (viewModel.scratchlistEnabled && composerState.text.isNotBlank()) {
                            viewModel::parkComposerDraft
                        } else {
                            null
                        },
                    )
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            app.hapi.companion.ui.theme.ReadingColumn {
                // Edge-to-edge (enforced by targetSdk 35+): the bar owns its own
                // system insets — nav-bar padding when the keyboard is closed,
                // IME padding when open (inset consumption prevents doubling).
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .imePadding(),
                ) {
                    if (!state.header.active && !state.isInitialLoading && !state.loadFailed) {
                        InactiveSessionBar(onReopen = viewModel::reopenSession)
                    }
                    QueuedMessagesBar(
                        rows = queuedRows,
                        onSteer = viewModel::steerQueuedMessage,
                        onRetry = viewModel::retryIndeterminateMessage,
                        onEdit = viewModel::editQueuedMessage,
                        onCancel = viewModel::cancelQueuedMessage,
                    )
                    ChatComposer(
                        state = composerState,
                        agentStatus = agentStatus,
                        contextUsage = contextUsage,
                        onTextChange = viewModel::setComposerText,
                        sessionId = viewModel.sessionId, sessions = allSessions,
                        schedule = sendSchedule, onSchedule = viewModel::setSchedule,
                        machineLabel = { id -> machines.firstOrNull { it.id == id }?.metadata?.let { it.displayName ?: it.host } ?: id.orEmpty() },
                        onSend = { viewModel.sendMessage() },
                        onSendSteer = { viewModel.sendMessage(steer = true) },
                        onAbort = viewModel::abortSession,
                        attachments = attachmentItems,
                        onAddAttachment = { attachmentSheetOpen = true },
                        onAttachmentRetry = viewModel.attachments::retry,
                        onAttachmentRemove = viewModel.attachments::remove,
                        slashSuggestions = slashSuggestions,
                        onSlashCommandSelected = viewModel::selectSlashCommand,
                        dictation = if (dictationAvailable) dictationState else null,
                        onDictationToggle = onDictationToggle,
                        onDictationCancel = { dictation?.cancel() },
                    )
                }
            }
        },
    ) { padding ->
        CompositionLocalProvider(
            LocalMarkdownRenderCache provides viewModel.markdownCache,
            LocalChatMedia provides media,
            LocalMarkdownLinkHandler provides rememberChatLinkHandler(onOpenFile = onOpenFile, onOpenSession = viewModel::openReference),
            LocalChatInteractions provides interactions,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                Box(modifier = Modifier.weight(1f)) {
                    when {
                        state.isInitialLoading -> InitialLoading()
                        state.loadFailed -> LoadFailed(onRetry = viewModel::retry)
                        state.blocks.isEmpty() && !state.hasMore -> EmptyChat()
                        else -> ChatTranscript(
                            state = state, paging = historyPaging, jumpToken = jumpToken,
                            location = location,
                            onLocationMissing = { scope.launch { snackbarHostState.showSnackbar(context.getString(R.string.chat_outline_missing)) } },
                            jumpingLatest = jumpingLatest,
                            onViewport = viewModel::readingViewportChanged,
                            onLayout = viewModel::historyLaidOut,
                            onRetryHistory = viewModel::loadOlder,
                            onJumpToLatest = viewModel::jumpToLatest,
                            listState = transcriptList, readingState = readingState,
                        )
                    }
                    if (!state.loadFailed) state.warning?.let { warning ->
                        Box(Modifier.align(Alignment.TopCenter).padding(8.dp)) {
                            DegradedBanner(warning, viewModel::retry)
                        }
                    }
                }
            }
        }
    }

    if (attachmentSheetOpen) {
        AttachmentPickerSheet(
            onDismiss = { attachmentSheetOpen = false },
            onPickPhotos = {
                photoPickerLauncher.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                )
            },
            onTakePhoto = onTakePhoto,
            onPickFiles = { documentPickerLauncher.launch(arrayOf("*/*")) },
        )
    }
    if (configSheetOpen) {
        SessionConfigSheet(
            config = configState,
            onDismiss = { configSheetOpen = false },
            onSetPermissionMode = viewModel::setPermissionMode,
            onSetModel = viewModel::setModel,
            onSetEffort = viewModel::setEffort,
            onLoadModelOptions = viewModel::loadModelOptions,
            onRefreshHermesModels = viewModel::refreshHermesModelOptions,
            onRefreshModels = viewModel::refreshModelOptions,
            onCollaborationMode = viewModel::setCollaborationMode,
            onServiceTier = viewModel::setServiceTier,
            onCopilotAgentMode = viewModel::setCopilotAgentMode,
        )
    }
    if (outlineOpen) ConversationOutline(outlineItems, state.hasMore,
        onDismiss = { outlineOpen = false }, onSelect = { id ->
            outlineOpen = false; readingState.followsTail = false
            location = id to ((location?.second ?: 0) + 1)
        }, onOlder = {
            outlineOpen = false; readingState.followsTail = false
            scope.launch { viewModel.setTranscriptVisible(true); transcriptList.scrollToItem(0); viewModel.loadOlder() }
        })
    if (archiveDialogOpen) ArchiveSessionDialog(state.header.title, { archiveDialogOpen = false }, {
        archiveDialogOpen = false; viewModel.archiveSession()
    })
    if (renameDialogOpen) {
        RenameSessionDialog(
            initialName = state.header.name ?: state.header.title,
            onConfirm = { name ->
                renameDialogOpen = false
                viewModel.renameSession(name)
            },
            onDismiss = { renameDialogOpen = false },
        )
    }
    if (deleteDialogOpen) {
        DeleteSessionDialog(
            sessionTitle = state.header.title,
            onConfirm = {
                deleteDialogOpen = false
                viewModel.deleteSession()
            },
            onDismiss = { deleteDialogOpen = false },
        )
    }
}

/**
 * Top-bar ⋮ menu: navigation entries first (Files always, Scratchlist with
 * entry count when enabled), then Rename always; Reopen only for inactive
 * sessions; Delete last.
 */
@Composable
private fun SessionOverflowMenu(
    id: String, title: String, active: Boolean, pinned: Boolean, globalPinned: Boolean,
    onPin: (PinMode) -> Unit, onUnread: () -> Unit, onArchive: () -> Unit, onOutline: () -> Unit,
    onRename: () -> Unit, onReopen: () -> Unit, onDelete: () -> Unit,
    onNewInDirectory: (() -> Unit)?, onOpenFiles: () -> Unit = {}, scratchlistCount: Int = 0,
    onOpenScratchlist: (() -> Unit)? = null, onParkDraft: (() -> Unit)? = null,
) {
    var expanded by remember { mutableStateOf(false) }
    IconButton(onClick = { expanded = true }) { Icon(Icons.Filled.MoreVert, stringResource(R.string.chat_session_actions)) }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        DropdownMenuItem(text = { Text(stringResource(R.string.chat_open_files)) }, onClick = { expanded = false; onOpenFiles() })
        DropdownMenuItem(text = { Text(stringResource(R.string.chat_outline)) }, onClick = { expanded = false; onOutline() })
        onOpenScratchlist?.let { action -> DropdownMenuItem(text = { Text(stringResource(R.string.chat_open_scratchlist_count, scratchlistCount)) }, onClick = { expanded = false; action() }) }
        onParkDraft?.let { action -> DropdownMenuItem(text = { Text(stringResource(R.string.chat_park_draft)) }, onClick = { expanded = false; action() }) }
        HorizontalDivider()
        SessionActionItems(id, title, active, pinned, globalPinned, { expanded = false }, onRename, onPin,
            onUnread, onArchive, onReopen, onDelete, onNewInDirectory)
    }
}

/**
 * Inactive-session affordance above the composer: sending auto-resumes
 * (B-M3ab), Reopen is the explicit restart without a message.
 */
@Composable
private fun InactiveSessionBar(onReopen: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.chat_inactive_bar),
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 4.dp, bottom = 4.dp),
            )
            TextButton(onClick = onReopen) { Text(stringResource(R.string.sessions_action_reopen)) }
        }
    }
}

@Composable
private fun ChatTitle(header: ChatHeaderUi, reconnecting: Boolean, retry: () -> Unit) {
    Column(Modifier.heightIn(min = 48.dp).then(if (reconnecting) Modifier.clickable(onClick = retry) else Modifier),
        verticalArrangement = Arrangement.Center) {
        Text(header.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        // Always reserve the subtitle slot; reconnect phases never resize the transcript.
        Text(
            if (reconnecting) stringResource(R.string.chat_reconnecting_retry) else header.subtitle.orEmpty(),
            style = app.hapi.companion.ui.theme.HapiTypography.caption,
            color = if (reconnecting) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DegradedBanner(warning: String, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = warning,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
        }
    }
}

// ----------------------------------------------------------------- states --

@Composable
private fun InitialLoading() {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(modifier = Modifier.size(12.dp))
        Text(
            text = stringResource(R.string.chat_loading_messages),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LoadFailed(onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.chat_load_failed_title), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.chat_load_failed_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.size(12.dp))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
    }
}

@Composable
private fun EmptyChat() {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.chat_empty_title), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.chat_empty_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ------------------------------------------------------------- notices --

/**
 * Localize a [ChatNotice] (B-M5a). Server/exception detail text, when
 * present, is shown verbatim — matching the pre-i18n `message ?: fallback`
 * behavior — so hub-side wording is never mistranslated.
 */
internal fun chatNoticeText(context: Context, notice: ChatNotice): String = when (notice) {
    ChatNotice.InvalidSchedule -> context.getString(R.string.chat_schedule_invalid)
    ChatNotice.ScheduleAttachments -> context.getString(R.string.chat_schedule_attachments)
    ChatNotice.ReferenceUnavailable -> context.getString(R.string.chat_reference_unavailable)
    is ChatNotice.SessionActionFailed -> notice.detail ?: context.getString(R.string.sessions_error_archive)
    ChatNotice.DraftParked -> context.getString(R.string.chat_notice_draft_parked)
    ChatNotice.ScratchlistFull -> context.getString(R.string.chat_notice_scratchlist_full)
    ChatNotice.ScratchlistParkFailed -> context.getString(R.string.chat_notice_park_failed)
    ChatNotice.AttachmentsUploading -> context.getString(R.string.chat_notice_attachments_uploading)
    ChatNotice.ResumeFailed -> context.getString(R.string.chat_notice_resume_failed)
    ChatNotice.QueuedEditKeptDraft -> context.getString(R.string.chat_notice_edit_kept_draft)
    ChatNotice.QueuedAlreadyDelivered -> context.getString(R.string.chat_notice_already_delivered)
    ChatNotice.QueuedDismissed -> context.getString(R.string.chat_queued_dismissed)
    ChatNotice.PermissionAlreadyHandled -> context.getString(R.string.chat_notice_request_already_handled)
    ChatNotice.DeleteConflictActive -> context.getString(R.string.sessions_error_delete_active)
    is ChatNotice.AbortFailed -> notice.detail ?: context.getString(R.string.chat_notice_abort_failed)
    is ChatNotice.RenameFailed -> notice.detail ?: context.getString(R.string.chat_notice_rename_failed)
    is ChatNotice.DeleteFailed -> notice.detail ?: context.getString(R.string.chat_notice_delete_failed)
    is ChatNotice.ReopenFailed -> notice.detail ?: context.getString(R.string.sessions_reopen_failed_fallback)
    is ChatNotice.CancelQueuedFailed -> notice.detail ?: context.getString(R.string.chat_notice_cancel_failed)
    is ChatNotice.SteerFailed -> notice.detail ?: context.getString(R.string.chat_notice_steer_failed)
    is ChatNotice.PermissionRequestFailed -> notice.detail ?: context.getString(R.string.chat_notice_request_failed)
    is ChatNotice.ModelsLoadFailed -> notice.detail ?: context.getString(R.string.chat_notice_models_failed)
    is ChatNotice.ConfigUpdateFailed -> notice.detail ?: context.getString(R.string.chat_notice_config_failed)
}
