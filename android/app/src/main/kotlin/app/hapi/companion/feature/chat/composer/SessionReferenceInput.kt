package app.hapi.companion.feature.chat.composer

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.Editable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.ReplacementSpan
import android.view.Gravity
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.focused
import androidx.compose.ui.semantics.insertTextAtCursor
import androidx.compose.ui.semantics.requestFocus
import androidx.compose.ui.semantics.editableText
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setText
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.hapi.companion.R
import app.hapi.protocol.session.SessionDiscovery
import app.hapi.protocol.session.SessionReferences
import app.hapi.protocol.wire.SessionSummary

/** An editable atom occupies one UTF-16 slot; wire/draft text always contains the full id. */
private class SessionSpan(val id: String, val title: String, val color: Int, val background: Int) : ReplacementSpan() {
    private val label = run {
        val boundary = android.icu.text.BreakIterator.getCharacterInstance().apply { setText(title) }
        var end = 0
        repeat(32) { val next = boundary.next(); if (next != java.text.BreakIterator.DONE) end = next }
        " @" + title.substring(0, end) + (if (end < title.length) "…" else "") + " "
    }
    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int =
        paint.measureText(label).toInt() + 8
    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val old = paint.color
        val width = paint.measureText(label) + 8
        paint.color = background
        canvas.drawRoundRect(RectF(x, y + paint.ascent() - 2, x + width, y + paint.descent() + 2), 8f, 8f, paint)
        paint.color = color
        canvas.drawText(label, x + 4, y.toFloat(), paint)
        paint.color = old
    }
}

internal class SessionEditText(context: Context) : EditText(context) {
    var changed: (String) -> Unit = {}
    var selectionChanged: (() -> Unit)? = null
    var linkColor: Int = 0
    var chipColor: Int = 0
    private var replacing = false
    private var lastExternalValue: String? = null
    fun syncValue(value: String) {
        if (value == lastExternalValue) return
        lastExternalValue = value
        setSerialized(value)
    }
    init {
        gravity = Gravity.TOP or Gravity.START
        background = null
        setPadding(0, 0, 0, 0)
        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        minLines = 1
        maxLines = 6
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { if (!replacing) { changed(serialize()); selectionChanged?.invoke() } }
        })
    }
    override fun onSelectionChanged(start: Int, end: Int) { super.onSelectionChanged(start, end); selectionChanged?.invoke() }
    fun serialize(start: Int = 0, end: Int = text.length): String {
        val value = text
        val from = start.coerceIn(0, value.length)
        val to = end.coerceIn(from, value.length)
        val out = StringBuilder()
        for (index in from until to) {
            val span = value.getSpans(index, index + 1, SessionSpan::class.java).firstOrNull()
            if (span == null) out.append(value[index]) else out.append(SessionReferences.markdown(span.title, span.id))
        }
        return out.toString()
    }
    private fun parse(value: String): SpannableStringBuilder {
        val out = SpannableStringBuilder()
        var cursor = 0
        for (mention in SessionReferences.mentions(value)) {
            out.append(value.substring(cursor, mention.start))
            val start = out.length
            out.append('\uFFFC')
            out.setSpan(SessionSpan(mention.id, mention.title, linkColor, chipColor), start, start + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            cursor = mention.end
        }
        out.append(value.substring(cursor))
        return out
    }
    fun setSerialized(value: String) {
        if (serialize() == value) return
        replacing = true
        setText(parse(value))
        setSelection(text.length)
        replacing = false
        selectionChanged?.invoke()
    }
    fun query(): Pair<Int, String>? {
        if (selectionStart < 0 || selectionStart != selectionEnd) return null
        val prefix = text.substring(0, selectionStart)
        val match = Regex("(?:^|\\s)@([^\\s@]*)$").find(prefix) ?: return null
        return (selectionStart - match.groupValues[1].length - 1) to match.groupValues[1]
    }
    fun insert(session: SessionSummary) {
        val query = query() ?: return
        var end = selectionEnd
        while (end < text.length && !text[end].isWhitespace() && text[end] != '\uFFFC') end++
        val value = parse(SessionReferences.markdown(SessionDiscovery.title(session), session.id) + " ")
        text.replace(query.first, end, value)
        setSelection(query.first + value.length)
        requestFocus()
    }
    override fun onTextContextMenuItem(id: Int): Boolean {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
        val end = maxOf(selectionStart, selectionEnd).coerceAtLeast(start)
        when (id) {
            android.R.id.copy, android.R.id.cut -> {
                clipboard.setPrimaryClip(ClipData.newPlainText("", serialize(start, end)))
                if (id == android.R.id.cut) text.delete(start, end)
                return true
            }
            android.R.id.paste, android.R.id.pasteAsPlainText -> {
                val clip = clipboard.primaryClip ?: return true
                val value = parse(clip.getItemAt(0).coerceToText(context).toString())
                text.replace(start, end, value); setSelection(start + value.length)
                return true
            }
        }
        return super.onTextContextMenuItem(id)
    }
}

@Composable
internal fun SessionReferenceInput(value: String, onChange: (String) -> Unit, sessionId: String,
    sessions: List<SessionSummary>, machineLabel: (String?) -> String, focusRequest: Long, modifier: Modifier = Modifier) {
    var editor by remember { mutableStateOf<SessionEditText?>(null) }
    var isFocused by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf<String?>(null) }
    val latestChange by rememberUpdatedState(onChange)
    val colors = MaterialTheme.colorScheme
    val hint = stringResource(R.string.chat_composer_placeholder)
    val candidates = remember(sessions, query, sessionId, machineLabel) {
        query?.let { SessionDiscovery.mentionCandidates(sessions, sessionId, it, machineLabel) }.orEmpty()
    }
    Column(modifier) {
        if (candidates.isNotEmpty()) {
            androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxWidth().heightIn(max = 200.dp)) {
                items(candidates.size, key = { candidates[it].id }) { index ->
                    val item = candidates[index]
                    DropdownMenuItem(text = { Text(SessionDiscovery.title(item), maxLines = 2) },
                        onClick = { editor?.insert(item) })
                }
            }
        }
        AndroidView(factory = { context -> SessionEditText(context).also { editor = it } },
            modifier = Modifier.fillMaxWidth().testTag("chat-composer-input").semantics {
                focused = isFocused
                requestFocus { editor?.requestFocus() ?: false }
                editableText = AnnotatedString(value)
                insertTextAtCursor { input ->
                    editor?.let { view ->
                        val start = minOf(view.selectionStart, view.selectionEnd).coerceAtLeast(0)
                        val end = maxOf(view.selectionStart, view.selectionEnd).coerceAtLeast(start)
                        view.text.replace(start, end, input.text)
                        view.setSelection(start + input.length)
                    }
                    true
                }
                setText { editor?.setSerialized(it.text); latestChange(it.text); true }
            },
            update = { view ->
                view.linkColor = colors.primary.toArgb(); view.chipColor = colors.secondaryContainer.toArgb()
                view.setTextColor(colors.onSurface.toArgb()); view.setHintTextColor(colors.onSurfaceVariant.toArgb())
                view.textSize = 16f; view.hint = hint
                view.onFocusChangeListener = android.view.View.OnFocusChangeListener { _, focused -> isFocused = focused }
                view.changed = { latestChange(it) }
                view.selectionChanged = { query = view.query()?.second }
                view.syncValue(value)
            })
    }
    var handledFocus by remember { mutableLongStateOf(focusRequest) }
    LaunchedEffect(focusRequest) {
        if (handledFocus != focusRequest) {
            handledFocus = focusRequest
            editor?.let { view -> view.requestFocus(); (view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(view, InputMethodManager.SHOW_IMPLICIT) }
        }
    }
}
