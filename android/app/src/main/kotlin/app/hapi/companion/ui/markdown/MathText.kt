package app.hapi.companion.ui.markdown

import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration

/** One offline WebView per math paragraph, so many small formulas share one renderer. */
@Composable
internal fun KaTeXMathText(text: AnnotatedString, style: TextStyle, codeBackground: Color) {
    val density = LocalDensity.current
    val color = if (style.color != Color.Unspecified) style.color else LocalContentColor.current
    val fontSize = if (style.fontSize.isSp) style.fontSize.value else 16f
    val fontSizePx = spFontToCssPx(fontSize, density.fontScale)
    val runs = remember(text, codeBackground, density.fontScale) {
        mathTextRuns(text, codeBackground, density.fontScale)
    }
    val links = remember(text) { text.getLinkAnnotations(0, text.length) }
    val spec = remember(text, runs, style, color, fontSizePx, density.fontScale) {
        val lineHeight = when {
            style.lineHeight.isSp -> "${spFontToCssPx(style.lineHeight.value, density.fontScale)}px"
            style.lineHeight.isEm -> "${style.lineHeight.value}em"
            else -> "1.5"
        }
        val align = when (style.textAlign) {
            TextAlign.Center -> "center"
            TextAlign.Right -> "right"
            TextAlign.End -> "end"
            TextAlign.Left -> "left"
            else -> "start"
        }
        MathRenderSpec(
            latex = text.text,
            displayMode = false,
            textColorArgb = color.toArgb(),
            fontSizePx = fontSizePx,
            runs = runs,
            bodyCss = "line-height:$lineHeight;text-align:$align;" +
                "font-weight:${style.fontWeight?.weight ?: 400};" +
                "font-style:${if (style.fontStyle == FontStyle.Italic) "italic" else "normal"};",
        )
    }
    // WebView has no text intrinsic width. Supply one for the native table
    // grid's intrinsic-size pass; incoming constraints still cap the paragraph.
    val measurer = rememberTextMeasurer()
    val intrinsic = remember(text, style, measurer) { measurer.measure(text, style, softWrap = false).size.width }
    KaTeXView(spec, Modifier.widthIn(min = with(density) { intrinsic.toDp() })) { index ->
        links.getOrNull(index)?.item?.let { link -> link.linkInteractionListener?.onClick(link) }
    }
}

/** Preserve native annotation/link decisions; user text is passed as JSON, never HTML. */
internal fun mathTextRuns(text: AnnotatedString, codeBackground: Color, fontScale: Float): List<MathTextRun> {
    val math = text.getStringAnnotations(INLINE_MATH_TAG, 0, text.length)
    val code = text.getStringAnnotations(INLINE_CODE_TAG, 0, text.length)
    val links = text.getLinkAnnotations(0, text.length)
    val boundaries = sortedSetOf(0, text.length)
    for (range in text.spanStyles) {
        boundaries.add(range.start)
        boundaries.add(range.end)
    }
    for (range in math + code) {
        boundaries.add(range.start)
        boundaries.add(range.end)
    }
    for (range in links) {
        boundaries.add(range.start)
        boundaries.add(range.end)
    }
    val runs = mutableListOf<MathTextRun>()
    var cursor = 0
    for (end in boundaries.drop(1)) {
        if (end <= cursor) continue
        val formula = math.firstOrNull { it.start == cursor }
        val runEnd = formula?.end ?: end
        var span = SpanStyle()
        val linkIndex = links.indexOfFirst { cursor >= it.start && cursor < it.end }
        if (linkIndex >= 0) span = span.merge(links[linkIndex].item.styles?.style ?: SpanStyle())
        for (range in text.spanStyles) {
            if (cursor >= range.start && cursor < range.end) span = span.merge(range.item)
        }
        val css = buildString {
            if (span.color != Color.Unspecified) append("color:${cssColor(span.color)};")
            span.fontWeight?.let { append("font-weight:${it.weight};") }
            if (span.fontStyle == FontStyle.Italic) append("font-style:italic;")
            if (span.fontSize.isEm) append("font-size:${span.fontSize.value}em;")
            if (span.fontSize.isSp) append("font-size:${spFontToCssPx(span.fontSize.value, fontScale)}px;")
            val decorations = listOfNotNull(
                "underline".takeIf { span.textDecoration?.contains(TextDecoration.Underline) == true },
                "line-through".takeIf { span.textDecoration?.contains(TextDecoration.LineThrough) == true },
            )
            if (decorations.isNotEmpty()) append("text-decoration:${decorations.joinToString(" ")};")
            if (code.any { cursor >= it.start && cursor < it.end }) {
                append("font-family:monospace;background:${cssColor(codeBackground)};border-radius:4px;padding:0 3px;")
            }
        }
        runs.add(MathTextRun(
            text = formula?.item ?: text.text.substring(cursor, runEnd),
            math = formula != null,
            css = css,
            link = linkIndex.takeIf { it >= 0 },
        ))
        cursor = runEnd
    }
    return runs
}

private fun cssColor(color: Color): String {
    val argb = color.toArgb()
    return "#%06X%02X".format(argb and 0xFFFFFF, argb ushr 24)
}
