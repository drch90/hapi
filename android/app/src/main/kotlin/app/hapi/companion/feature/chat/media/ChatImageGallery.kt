package app.hapi.companion.feature.chat.media

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ChatMedia
import app.hapi.companion.feature.chat.attachments.AttachmentPolicy
import app.hapi.protocol.chat.*
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.imageLoader
import java.nio.ByteBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal data class ChatImage(val id: String, val name: String, val source: String)
internal val LocalImageGallery = staticCompositionLocalOf<((ChatImage) -> Unit)?> { null }

internal fun chatImages(blocks: List<VisibleChatBlock>, media: ChatMedia): List<ChatImage> = buildList {
    fun visit(block: VisibleChatBlock) {
        when (block) {
            is GeneratedImageBlock -> if (inlineMediaKind(block.mimeType) == InlineMediaKind.Image) {
                media.generatedImageUrl(block.imageId)?.let { add(ChatImage("generated:${block.id}", block.fileName, it)) }
            }
            is UserTextBlock -> block.attachments.orEmpty().forEach { attachment ->
                attachmentImage(block.id, attachment)?.let(::add)
            }
            is ToolCallBlock -> block.children.forEach(::visit)
            is ToolGroupBlock -> block.tools.forEach(::visit)
            else -> Unit
        }
    }
    blocks.forEach(::visit)
}.distinctBy { it.id }

internal fun attachmentImage(blockId: String, attachment: ChatAttachment): ChatImage? {
    val source = attachment.previewUrl ?: return null
    // Previews are embedded data, never an arbitrary URL given our authenticated loader.
    if (!attachment.mimeType.startsWith("image/") || !source.startsWith("data:image/")) return null
    return ChatImage("attachment:$blockId:${attachment.id}", attachment.filename, source)
}

@Composable
internal fun ChatImageGallery(blocks: List<VisibleChatBlock>, media: ChatMedia, content: @Composable () -> Unit) {
    val images = remember(blocks, media) { chatImages(blocks, media) }
    var selected by remember { mutableStateOf<Pair<List<ChatImage>, Int>?>(null) }
    val open: (ChatImage) -> Unit = { image ->
        val snapshot = if (images.any { it.id == image.id }) images else images + image
        selected = snapshot to snapshot.indexOfFirst { it.id == image.id }
    }
    CompositionLocalProvider(LocalImageGallery provides open) { content() }
    selected?.let { (snapshot, index) ->
        ImageGalleryDialog(snapshot, index, media.imageLoader) { selected = null }
    }
}

@Composable
internal fun ChatImagePreview(image: ChatImage, loader: ImageLoader?, modifier: Modifier = Modifier) {
    val open = LocalImageGallery.current
    var standalone by remember(image.id) { mutableStateOf(false) }
    Box(modifier.clickable { if (open != null) open(image) else standalone = true }) {
        LoadedImage(image, loader, Modifier.fillMaxWidth())
    }
    if (standalone) ImageGalleryDialog(listOf(image), 0, loader) { standalone = false }
}

@Composable
private fun LoadedImage(image: ChatImage, loader: ImageLoader?, modifier: Modifier) {
    var failed by remember(image.source) { mutableStateOf(false) }
    var loading by remember(image.source) { mutableStateOf(true) }
    var retry by remember(image.source) { mutableIntStateOf(0) }
    val decoded by produceState<Pair<Boolean, Any?>>(false to null, image.source, retry) {
        val model = if (image.source.startsWith("data:")) withContext(Dispatchers.Default) {
            AttachmentPolicy.bytesFromDataUrl(image.source)?.let { ByteBuffer.wrap(it) }
        } else image.source
        value = true to model
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        if (decoded.first && decoded.second != null) key(image.source, retry) {
            AsyncImage(model = decoded.second, imageLoader = loader ?: LocalContext.current.imageLoader,
                contentDescription = image.name, contentScale = ContentScale.Fit,
                onLoading = { loading = true; failed = false },
                onSuccess = { loading = false; failed = false },
                onError = { loading = false; failed = true },
                modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp))
        }
        val decodeFailed = decoded.first && decoded.second == null
        if (loading && !decodeFailed) CircularProgressIndicator(Modifier.size(28.dp))
        if (failed || decodeFailed) TextButton(onClick = { retry++ }) { Text(stringResource(R.string.chat_media_image_retry)) }
    }
}

@Composable
internal fun ImageGalleryDialog(images: List<ChatImage>, initialIndex: Int, loader: ImageLoader?, onClose: () -> Unit) {
    var index by remember(images) { mutableIntStateOf(initialIndex) }
    var scale by remember(index) { mutableFloatStateOf(1f) }
    var offset by remember(index) { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    fun zoom(value: Float) { scale = value.coerceIn(0.25f, 8f); offset = Offset.Zero }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(color = Color.Black, contentColor = Color.White, modifier = Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(images[index].name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = onClose) { Text(stringResource(R.string.chat_media_close)) }
                }
                Box(Modifier.weight(1f).fillMaxWidth().clipToBounds().background(Color.Black)
                    .onSizeChanged { viewport = it }
                    .pointerInput(index) {
                        detectTransformGestures { _, pan, factor, _ ->
                            scale = (scale * factor).coerceIn(0.25f, 8f)
                            val maxX = viewport.width * (scale - 1).coerceAtLeast(0f) / 2
                            val maxY = viewport.height * (scale - 1).coerceAtLeast(0f) / 2
                            offset = Offset((offset.x + pan.x).coerceIn(-maxX, maxX), (offset.y + pan.y).coerceIn(-maxY, maxY))
                        }
                    }, contentAlignment = Alignment.Center) {
                    LoadedImage(images[index], loader, Modifier.fillMaxWidth().graphicsLayer {
                        scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y
                    })
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { zoom(scale / 1.5f) }, enabled = scale > 0.25f) { Text("−") }
                    TextButton(onClick = { zoom(1f) }) { Text("${(scale * 100).toInt()}%") }
                    TextButton(onClick = { zoom(scale * 1.5f) }, enabled = scale < 8f) { Text("+") }
                }
                if (images.size > 1) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { index-- }, enabled = index > 0) { Text(stringResource(R.string.chat_media_previous)) }
                    Text("${index + 1} / ${images.size}")
                    TextButton(onClick = { index++ }, enabled = index < images.lastIndex) { Text(stringResource(R.string.chat_media_next)) }
                }
            }
        }
    }
}
