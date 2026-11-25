package app.hapi.companion.ui.markdown

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withAnnotation
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.em
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MathTextTest {
    @Test
    fun keepsFormulasAtomicAndPreservesSurroundingEmphasis() {
        val latex = "60^\\circ"
        val text = buildAnnotatedString {
            append("领先 ")
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
                withAnnotation(INLINE_MATH_TAG, latex) { append(latex) }
            }
            append("，继续。")
        }
        val runs = mathTextRuns(text, Color.LightGray, 1f)
        assertEquals(listOf("领先 ", latex, "，继续。"), runs.map { it.text })
        assertEquals(listOf(false, true, false), runs.map { it.math })
        assertTrue(runs[1].css.contains("font-weight:600"))
        assertFalse(runs[1].css.contains("monospace"))
    }

    @Test
    fun preservesCodeStylingAndNativeLinkHandlersBesideMath() {
        var opened = false
        val link = LinkAnnotation.Clickable(
            "native-file", TextLinkStyles(SpanStyle(color = Color.Blue)),
            LinkInteractionListener { opened = true },
        )
        val text = buildAnnotatedString {
            withLink(link) {
                withAnnotation(INLINE_CODE_TAG, "") {
                    withStyle(SpanStyle(fontSize = 0.875.em)) { append("src/file.kt") }
                }
            }
            append(" ")
            withAnnotation(INLINE_MATH_TAG, "x^2") { append("x^2") }
        }
        val runs = mathTextRuns(text, Color.Black.copy(alpha = 0.25f), 1.3f)
        assertEquals(0, runs.first().link)
        assertTrue(runs.first().css.contains("color:#0000FF"))
        assertTrue(runs.first().css.contains("font-family:monospace"))
        assertTrue(runs.first().css.contains("background:#00000040"))
        assertTrue(runs.first().css.contains("font-size:0.875em"))
        val nativeLink = text.getLinkAnnotations(0, text.length)[runs.first().link!!].item
        nativeLink.linkInteractionListener?.onClick(nativeLink)
        assertTrue(opened)
        assertEquals("x^2", runs.single { it.math }.text)
    }
}
