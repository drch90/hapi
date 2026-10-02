package app.hapi.protocol.session

import app.hapi.protocol.wire.SessionSummary
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.BreakIterator
import java.util.Locale
import kotlinx.serialization.json.JsonPrimitive

/** Wire-compatible with web sessionReference/composerSegments. Never a public share URL. */
object SessionReferences {
    private val pathPattern = Regex("^(?:\\.?/)?(?:[\\w.-]+/)*sessions/([^/?#]+)/?$")
    private val linkPattern = Regex("\\[((?:\\\\.|[^\\]\\\\])*)\\]\\(([^)]+)\\)")
    const val STEER_SUFFIX = " HAPI hub peer - call inspect_peer with that session id; do not Grep/Glob/Read /sessions/ as a local file."

    fun title(value: String): String {
        val normalized = value.replace(Regex("\\s+"), " ").trim()
        val iterator = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(normalized) }
        var end = iterator.first()
        repeat(120) {
            val next = iterator.next()
            if (next == BreakIterator.DONE) return normalized
            end = next
        }
        return normalized.substring(0, end)
    }

    fun path(id: String): String = "/sessions/" + URLEncoder.encode(id, "UTF-8").replace("+", "%20")
    fun parsePath(href: String): String? {
        val match = pathPattern.matchEntire(href.trim()) ?: return null
        return runCatching { URLDecoder.decode(match.groupValues[1].replace("+", "%2B"), "UTF-8") }
            .getOrNull()?.takeIf { it.isNotEmpty() && '.' !in it && '/' !in it && '\\' !in it }
    }
    fun copyText(name: String, id: String): String {
        val clean = title(name)
        val text = if (clean.isEmpty()) "See HAPI session ${path(id)} for context"
            else "See session ${JsonPrimitive(clean)} (${path(id)}) for context"
        return "$text.$STEER_SUFFIX"
    }
    fun markdown(name: String, id: String): String {
        val label = title(name).ifEmpty { id.take(8) }.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
        return "[$label](${path(id)})"
    }
    data class Mention(val start: Int, val end: Int, val id: String, val title: String)
    fun mentions(text: String): List<Mention> = linkPattern.findAll(text).mapNotNull { match ->
        val id = parsePath(match.groupValues[2]) ?: return@mapNotNull null
        Mention(match.range.first, match.range.last + 1, id,
            match.groupValues[1].replace(Regex("\\\\([\\\\\\[\\]])"), "$1"))
    }.toList()
}

object SessionDiscovery {
    fun title(session: SessionSummary): String = session.metadata?.let { meta ->
        meta.name?.takeIf { it.isNotBlank() } ?: meta.summary?.text?.takeIf { it.isNotBlank() }
            ?: meta.path.split('/', '\\').lastOrNull { it.isNotBlank() }
    } ?: session.id.take(8)

    fun visible(session: SessionSummary): Boolean = session.active || session.pinned == true || session.globalPinned == true ||
        session.hasConversationContent || !session.metadata?.agentSessionId.isNullOrBlank() ||
        !session.metadata?.name.isNullOrBlank() || !session.metadata?.summary?.text.isNullOrBlank()

    /** AND across terms, weighted fields, substring or * / ? wildcard matching. */
    fun score(session: SessionSummary, query: String, machine: String = ""): Double? {
        val normalized = query.trim().lowercase(Locale.ROOT)
        if (normalized.isEmpty()) return 0.0
        val meta = session.metadata
        val fields = listOf(title(session) to 10.0, (meta?.worktree?.name ?: meta?.worktree?.branch.orEmpty()) to 5.0,
            meta?.summary?.text.orEmpty() to 3.0, meta?.flavor.orEmpty() to 2.0, machine to 2.0,
            meta?.path.orEmpty() to 1.0, meta?.worktree?.basePath.orEmpty() to 1.0,
            meta?.worktree?.worktreePath.orEmpty() to 1.0, session.id to 0.5)
        var score = 0.0
        for (term in normalized.split(Regex("\\s+"))) {
            val wildcard = '*' in term || '?' in term
            val pattern = if (wildcard) Regex(term.map { when (it) { '*' -> ".*"; '?' -> "."; else -> Regex.escape(it.toString()) } }.joinToString(""), RegexOption.IGNORE_CASE) else null
            val boundary = Regex("(?:^|[^a-z0-9])${Regex.escape(term)}(?:[^a-z0-9]|$)")
            val best = fields.maxOf { (raw, weight) ->
                val value = raw.lowercase(Locale.ROOT)
                if (pattern?.containsMatchIn(value) ?: value.contains(term)) weight * if (wildcard || boundary.containsMatchIn(value)) 1.75 else 1.0 else 0.0
            }
            if (best == 0.0) return null
            score += best
        }
        val name = title(session).trim().lowercase(Locale.ROOT)
        if (name == normalized) score += 50 else if (' ' in normalized && name.contains(normalized)) score += 25
        return score
    }

    /** Sidebar deduplication: live connection, selected row, pin, then recency. */
    fun prepare(sessions: List<SessionSummary>, selected: String? = null): List<SessionSummary> {
        val preference = compareByDescending<SessionSummary> { it.active }
            .thenByDescending { it.id == selected }.thenByDescending { it.globalPinned == true }
            .thenByDescending { it.pinned == true }.thenByDescending { it.updatedAt }
        val winners = sessions.groupBy { session ->
            session.metadata?.agentSessionId?.trim()?.takeIf { it.isNotEmpty() }?.let {
                "${session.metadata?.flavor ?: "unknown"}:$it"
            } ?: "session:${session.id}"
        }.values.map { it.sortedWith(preference).first().id }.toSet()
        return sessions.filter { it.id in winners && (it.id == selected || visible(it)) }
    }

    fun mentionCandidates(sessions: List<SessionSummary>, current: String, query: String, machine: (String?) -> String): List<SessionSummary> {
        val normalized = query.trim().lowercase(Locale.ROOT)
        return prepare(sessions, current)
            .filter { it.id != current && it.hasConversationContent && (normalized.isNotEmpty() || it.metadata?.lifecycleState != "archived") }
            .mapNotNull { session ->
                if (score(session, normalized, machine(session.metadata?.machineId)) == null) return@mapNotNull null
                val name = title(session).lowercase(Locale.ROOT)
                val id = session.id.lowercase(Locale.ROOT)
                val rank = if (normalized.isEmpty()) 0 else when {
                    name == normalized -> 500
                    name.startsWith(normalized) -> 400
                    name.contains(normalized) -> 300
                    id.startsWith(normalized) -> 200
                    id.contains(normalized) -> 100
                    else -> 150
                }
                session to (rank + (if (session.active) 50 else 0) - (if (session.metadata?.lifecycleState == "archived") 25 else 0))
            }.sortedWith(compareByDescending<Pair<SessionSummary, Int>> { it.second }.thenByDescending { it.first.updatedAt })
            .take(20).map { it.first }
    }
}
