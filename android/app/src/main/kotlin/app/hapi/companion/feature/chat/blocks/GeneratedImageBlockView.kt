package app.hapi.companion.feature.chat.blocks

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import app.hapi.companion.feature.chat.media.GeneratedMediaCard
import app.hapi.protocol.chat.GeneratedImageBlock

/** The wire block keeps its legacy name but can contain any media/file MIME type. */
@Composable
fun GeneratedImageBlockView(block: GeneratedImageBlock, modifier: Modifier = Modifier) =
    GeneratedMediaCard(block, modifier)
