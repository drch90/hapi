package app.hapi.companion.feature.chat

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import androidx.core.content.FileProvider
import java.io.File
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal const val SHARE_IMAGE_WIDTH = 1080
internal const val SHARE_IMAGE_HEIGHT = 4096
private const val MARGIN = 48

/** Bounded text layouts and a single bitmap at a time, even for very long replies. */
internal suspend fun exportMessageImages(
    context: Context,
    messages: List<ShareMessage>,
    userLabel: String,
    assistantLabel: String,
    onPage: suspend (Int) -> Unit = {},
): List<File> {
    require(messages.isNotEmpty())
    val directory = File(context.cacheDir, "message-images").apply { mkdirs() }
    directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }?.forEach { it.delete() }
    val files = mutableListOf<File>()
    var bitmap: Bitmap? = null
    var canvas: Canvas? = null
    var y = MARGIN
    fun startPage() {
        bitmap = Bitmap.createBitmap(SHARE_IMAGE_WIDTH, SHARE_IMAGE_HEIGHT, Bitmap.Config.ARGB_8888)
        canvas = Canvas(bitmap!!).apply { drawColor(Color.WHITE) }
        y = MARGIN
    }
    suspend fun finishPage() {
        val source = bitmap ?: return
        // Keep the final image compact instead of adding a large empty tail.
        val cropped = Bitmap.createBitmap(source, 0, 0, SHARE_IMAGE_WIDTH, (y + MARGIN).coerceAtMost(SHARE_IMAGE_HEIGHT))
        try {
            val file = File.createTempFile("hapi-", ".png", directory)
            files += file
            file.outputStream().use { check(cropped.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        } finally {
            if (cropped !== source) cropped.recycle()
            source.recycle()
            bitmap = null
            canvas = null
        }
        onPage(files.size)
    }
    suspend fun text(value: String, heading: Boolean = false) {
        val paint = TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = if (heading) Color.rgb(53, 83, 123) else Color.rgb(25, 25, 25)
            textSize = if (heading) 28f else 32f
            typeface = if (heading) Typeface.DEFAULT_BOLD else Typeface.MONOSPACE
        }
        var offset = 0
        while (offset < value.length) {
            currentCoroutineContext().ensureActive()
            val part = readTextPage(value, offset, TextBudget(4000, 100))
            val layout = StaticLayout.Builder.obtain(part.text, 0, part.text.length, paint, SHARE_IMAGE_WIDTH - MARGIN * 2)
                .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false).setLineSpacing(8f, 1f).build()
            var line = 0
            while (line < layout.lineCount) {
                currentCoroutineContext().ensureActive()
                if (bitmap == null) startPage()
                val top = layout.getLineTop(line)
                var last = line
                while (last < layout.lineCount && layout.getLineBottom(last) - top <= SHARE_IMAGE_HEIGHT - MARGIN - y) last++
                if (last == line) {
                    finishPage()
                    continue
                }
                val height = layout.getLineBottom(last - 1) - top
                canvas!!.save()
                canvas!!.clipRect(MARGIN, y, SHARE_IMAGE_WIDTH - MARGIN, y + height)
                canvas!!.translate(MARGIN.toFloat(), (y - top).toFloat())
                layout.draw(canvas!!)
                canvas!!.restore()
                y += height
                line = last
                if (line < layout.lineCount) finishPage()
            }
            offset = part.end
        }
    }
    try {
        for (message in messages) {
            text("${if (message.user) userLabel else assistantLabel} · ${messageTimestamp(message.timestamp)}", heading = true)
            y += 16
            text(message.text)
            for (filename in message.filenames) text("[${filename}]", heading = true)
            y += 32
        }
        if (bitmap != null) finishPage()
        return files
    } catch (error: Throwable) {
        files.forEach { it.delete() }
        throw error
    } finally {
        bitmap?.recycle()
    }
}

internal fun messageImageShareIntent(context: Context, files: List<File>): Intent {
    require(files.isNotEmpty())
    val uris = ArrayList(files.map { FileProvider.getUriForFile(context, context.packageName + ".attachments", it) })
    return Intent(if (uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE).apply {
        type = "image/png"
        if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris.first()) else putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        clipData = ClipData.newRawUri("HAPI", uris.first()).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
}
