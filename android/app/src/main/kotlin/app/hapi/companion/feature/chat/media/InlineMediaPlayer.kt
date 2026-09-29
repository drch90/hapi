package app.hapi.companion.feature.chat.media

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.hapi.companion.R
import java.io.File

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
internal fun InlineMediaPlayer(file: File, video: Boolean) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var failed by remember(file) { mutableStateOf(false) }
    var fullscreen by remember(file) { mutableStateOf(false) }
    val player = remember(file, lifecycle) {
        ExoPlayer.Builder(context).build().apply {
            setAudioAttributes(AudioAttributes.DEFAULT, true)
            setHandleAudioBecomingNoisy(true)
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            playWhenReady = false
            prepare()
        }
    }
    DisposableEffect(player, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) player.pause() }
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) { failed = true }
        }
        player.addListener(listener)
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            player.removeListener(listener)
            player.release()
        }
    }
    if (failed) {
        Text(stringResource(R.string.chat_media_play_failed), color = MaterialTheme.colorScheme.error)
        TextButton(onClick = { failed = false; player.prepare() }) { Text(stringResource(R.string.chat_media_retry)) }
    }
    if (fullscreen) {
        Dialog(onDismissRequest = { fullscreen = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Surface(Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize().systemBarsPadding()) {
                    TextButton(onClick = { fullscreen = false }) { Text(stringResource(R.string.chat_media_close)) }
                    PlayerSurface(player, Modifier.weight(1f).fillMaxWidth())
                }
            }
        }
    } else PlayerSurface(player, Modifier.fillMaxWidth().height(if (video) 240.dp else 100.dp))
    if (video && !fullscreen) TextButton(onClick = { fullscreen = true }) { Text(stringResource(R.string.chat_media_fullscreen)) }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun PlayerSurface(player: ExoPlayer, modifier: Modifier) {
    AndroidView(modifier = modifier, factory = { context ->
        PlayerView(context).apply { useController = true; controllerShowTimeoutMs = 0 }
    }, update = { it.player = player }, onReset = null, onRelease = { it.player = null })
}
