package app.hapi.companion.feature.chat.media

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatMedia
import app.hapi.protocol.chat.GeneratedImageBlock
import java.io.File
import kotlinx.coroutines.*

@Composable
internal fun GeneratedMediaCard(block: GeneratedImageBlock, modifier: Modifier = Modifier) {
    val media = LocalChatMedia.current
    key(media, block.imageId) {
        val kind = inlineMediaKind(block.mimeType)
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        var localFile by remember { mutableStateOf<File?>(null) }
        var loading by remember { mutableStateOf(false) }
        var failed by remember { mutableStateOf(false) }
        var saving by remember { mutableStateOf(false) }
        var download by remember { mutableStateOf<Job?>(null) }
        DisposableEffect(Unit) { onDispose { localFile?.delete() } }
        val save = rememberLauncherForActivityResult(
            ActivityResultContracts.CreateDocument(block.mimeType?.substringBefore(';') ?: "application/octet-stream"),
        ) { uri ->
            val source = localFile
            if (uri != null && source != null) scope.launch {
                saving = true
                try {
                    withContext(Dispatchers.IO) {
                        val output = context.contentResolver.openOutputStream(uri) ?: error("Cannot open destination")
                        output.use { out -> source.inputStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                ensureActive()
                                val count = input.read(buffer)
                                if (count < 0) break
                                out.write(buffer, 0, count)
                            }
                        } }
                    }
                    Toast.makeText(context, R.string.chat_media_saved, Toast.LENGTH_SHORT).show()
                } catch (cancel: CancellationException) { throw cancel
                } catch (_: Exception) {
                    Toast.makeText(context, R.string.chat_media_save_failed, Toast.LENGTH_LONG).show()
                } finally { saving = false }
            }
        }
        fun load() {
            if (loading) return
            download = scope.launch {
                loading = true
                failed = false
                var target: File? = null
                try {
                    val destination = withContext(Dispatchers.IO) {
                        val directory = File(context.cacheDir, "chat-media").apply { mkdirs() }
                        directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }
                            ?.forEach { it.delete() }
                        File.createTempFile("media-", ".bin", directory).also { target = it }
                    }
                    val fetch = media.downloadMedia ?: error("Media is unavailable")
                    fetch(block.imageId, destination)
                    ensureActive()
                    localFile = destination
                    target = null
                } catch (cancel: CancellationException) { throw cancel
                } catch (_: Exception) { failed = true
                } finally { target?.delete(); loading = false }
            }
        }
        Surface(modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLow) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(when (kind) {
                    InlineMediaKind.Image -> R.string.chat_media_image
                    InlineMediaKind.Video -> R.string.chat_media_video
                    InlineMediaKind.Audio -> R.string.chat_media_audio
                    InlineMediaKind.File -> R.string.chat_media_file
                }, block.fileName), style = MaterialTheme.typography.labelMedium)
                if (kind == InlineMediaKind.Image) {
                    val url = media.generatedImageUrl(block.imageId)
                    if (url == null) Text(stringResource(R.string.chat_media_unavailable))
                    else ChatImagePreview(ChatImage("generated:${block.id}", block.fileName, url), media.imageLoader,
                        Modifier.fillMaxWidth().heightIn(max = 360.dp))
                } else {
                    val file = localFile
                    when {
                        loading -> {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                            TextButton(onClick = { download?.cancel() }) { Text(stringResource(R.string.chat_cancel)) }
                        }
                        file != null -> {
                            Text(mediaFileSize(file.length().toDouble()), style = MaterialTheme.typography.bodySmall)
                            if (kind == InlineMediaKind.Video || kind == InlineMediaKind.Audio) {
                                InlineMediaPlayer(file, kind == InlineMediaKind.Video)
                            }
                            TextButton(enabled = !saving, onClick = { save.launch(mediaFileName(block.fileName)) }) {
                                Text(stringResource(if (saving) R.string.chat_media_saving else R.string.chat_media_save))
                            }
                        }
                        else -> {
                            if (failed) Text(stringResource(R.string.chat_media_load_failed), color = MaterialTheme.colorScheme.error)
                            TextButton(enabled = media.downloadMedia != null, onClick = ::load) {
                                Text(stringResource(if (failed) R.string.chat_media_retry else when (kind) {
                                    InlineMediaKind.Video -> R.string.chat_media_load_video
                                    InlineMediaKind.Audio -> R.string.chat_media_load_audio
                                    else -> R.string.chat_media_prepare_download
                                }))
                            }
                        }
                    }
                }
            }
        }
    }
}
