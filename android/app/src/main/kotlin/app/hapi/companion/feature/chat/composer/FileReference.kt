package app.hapi.companion.feature.chat.composer

/** Inline code keeps spaces/backticks in a path unambiguous in the composed message. */
internal fun formatFileReference(path: String): String {
    val fence = "`".repeat((Regex("`+").findAll(path).maxOfOrNull { it.value.length } ?: 0) + 1)
    val needsPadding = path.startsWith('`') || path.endsWith('`') ||
        (path.startsWith(' ') && path.endsWith(' ') && path.any { it != ' ' })
    return if (needsPadding) "$fence $path $fence" else "$fence$path$fence"
}
