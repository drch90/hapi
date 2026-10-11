package app.hapi.protocol.markdown

import java.util.Locale

data class FileLinkTarget(val path: String, val line: Int? = null, val column: Int? = null)

/**
 * Workspace-aware destination resolution for explicit Markdown file links.
 * Mirrors the web anchor's markdown-href-policy, before URL scheme handling.
 * The runner still enforces containment when reading the file.
 */
object FileLinkPolicy {
    private val lineSuffix = Regex(""":(\d+)(?::(\d+))?$""")
    private val encodedBytes = Regex("(?:%[0-9a-fA-F]{2})+")
    private val malformedEscape = Regex("%(?![0-9a-fA-F]{2})")
    private val posixHome = Regex("""^(/(?:home|Users)/[^/]+)""")
    private val windowsHome = Regex("""^([A-Za-z]:[\\/]Users[\\/][^\\/]+)""", RegexOption.IGNORE_CASE)

    fun resolve(href: String, workspacePath: String? = null): FileLinkTarget? {
        // Split metadata before decoding: an encoded # or ? belongs to the filename.
        val rawPath = href.trim().substringBefore('#').substringBefore('?')
        val decoded = decodePath(rawPath) ?: return null
        if (decoded.isEmpty() || decoded.any { it.code < 32 || it.code == 127 }) return null
        val suffix = lineSuffix.find(decoded)
        val path = if (suffix == null) decoded else decoded.substring(0, suffix.range.first)
        if (!MarkdownTransforms.hasKnownFileExtension(path)) return null

        val target = if (path.startsWith("~/")) {
            expandHome(path, workspacePath ?: return null) ?: return null
        } else path
        val windows = MarkdownTransforms.isWindowsAbsolutePath(target)
        if ((if (windows) target.drop(2) else target).contains(':')) return null
        if (target.startsWith("//") || target.startsWith('\\')) return null

        if (windows || target.startsWith('/')) {
            if (workspacePath == null || !isWithinWorkspace(target, workspacePath)) return null
        } else if (".." in target.split('/', '\\')) {
            return null
        }
        return FileLinkTarget(
            path = target,
            line = suffix?.groupValues?.get(1)?.toIntOrNull()?.takeIf { it > 0 },
            column = suffix?.groupValues?.get(2)?.toIntOrNull()?.takeIf { it > 0 },
        )
    }

    /** Strict URI decoding, preserving literal plus signs and unescaped Unicode. */
    private fun decodePath(value: String): String? {
        if (malformedEscape.containsMatchIn(value)) return null
        return runCatching {
            encodedBytes.replace(value) { match ->
                ByteArray(match.value.length / 3) { index ->
                    match.value.substring(index * 3 + 1, index * 3 + 3).toInt(16).toByte()
                }.decodeToString(throwOnInvalidSequence = true)
            }
        }.getOrNull()
    }

    private fun expandHome(path: String, workspacePath: String): String? {
        val home = when {
            workspacePath == "/root" || workspacePath.startsWith("/root/") -> "/root"
            else -> posixHome.find(workspacePath)?.groupValues?.get(1)
                ?: windowsHome.find(workspacePath)?.groupValues?.get(1)
        } ?: return null
        val separator = if (home.contains('\\')) "\\" else "/"
        return home + separator + path.drop(2).replace("\\", "/").replace("/", separator)
    }

    private fun isWithinWorkspace(path: String, workspacePath: String): Boolean {
        val target = normalizeAbsolutePath(path) ?: return false
        val root = normalizeAbsolutePath(workspacePath) ?: return false
        return target == root || target.startsWith(root.trimEnd('/') + "/")
    }

    /** Normalize remote paths lexically, independently of the Android host OS. */
    private fun normalizeAbsolutePath(path: String): String? {
        val windows = MarkdownTransforms.isWindowsAbsolutePath(path)
        val normalized = if (windows) path.replace('\\', '/').lowercase(Locale.ROOT) else path
        if (!windows && (!normalized.startsWith('/') || normalized.startsWith("//"))) return null
        val prefix = if (windows) normalized.take(2) + "/" else "/"
        val segments = mutableListOf<String>()
        for (segment in normalized.substring(prefix.length).split('/')) {
            when (segment) {
                "", "." -> Unit
                ".." -> if (segments.isEmpty()) return null else segments.removeAt(segments.lastIndex)
                else -> segments += segment
            }
        }
        return prefix + segments.joinToString("/")
    }
}
