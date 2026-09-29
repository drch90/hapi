package app.hapi.companion.feature.chat.media

import java.util.Locale

internal enum class InlineMediaKind { Image, Video, Audio, File }

/** Null retains the legacy generated-image default, just as on web. */
internal fun inlineMediaKind(mimeType: String?): InlineMediaKind {
    val mime = mimeType?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
    return when {
        mime == null || mime.startsWith("image/") -> InlineMediaKind.Image
        mime.startsWith("video/") -> InlineMediaKind.Video
        mime.startsWith("audio/") -> InlineMediaKind.Audio
        else -> InlineMediaKind.File
    }
}

internal fun mediaFileName(name: String): String = name.substringAfterLast('/').substringAfterLast('\\')
    .filter { !it.isISOControl() }.take(200).takeUnless { it.isBlank() || it == "." || it == ".." } ?: "download"

internal fun mediaFileSize(bytes: Double): String = when {
    !bytes.isFinite() || bytes < 0 -> ""
    bytes < 1024 -> "${bytes.toLong()} B"
    bytes < 1024 * 1024 -> String.format(Locale.getDefault(), "%.1f KB", bytes / 1024)
    else -> String.format(Locale.getDefault(), "%.1f MB", bytes / (1024 * 1024))
}
