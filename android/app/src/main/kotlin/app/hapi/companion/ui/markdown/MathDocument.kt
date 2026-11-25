package app.hapi.companion.ui.markdown

import kotlin.math.roundToInt

/**
 * Pure (JVM-testable) HTML document builder for the offline KaTeX WebView.
 *
 * The document loads `katex.min.css` / `katex.min.js` from the bundled
 * `assets/katex/` directory via the WebView's `file:///android_asset/katex/`
 * base URL — no http(s) URL appears anywhere, and the WebView client blocks
 * network loads on top (offline iron rule).
 *
 * Error semantics mirror the web pipeline (`rehype-katex` three-tier):
 *  1. `throwOnError: true` — render or throw;
 *  2. `strict: 'ignore'` + `throwOnError: false` — KaTeX renders its own red
 *     inline error for unsupported commands;
 *  3. anything still failing degrades to a monospace `<pre>` with the raw TeX
 *     (`color: #cc0000`, `title` carrying the message — web `katex-error`).
 */
internal data class MathRenderSpec(
    val latex: String,
    val displayMode: Boolean,
    /** ARGB color the formula text should inherit (KaTeX uses currentColor). */
    val textColorArgb: Int,
    /** Body font size in CSS px (density-independent like dp); see [spFontToCssPx]. */
    val fontSizePx: Int,
    /** Styled paragraph runs; null renders the single [latex] formula. */
    val runs: List<MathTextRun>? = null,
    val bodyCss: String = "",
)

internal data class MathTextRun(
    val text: String,
    val math: Boolean = false,
    val css: String = "",
    val link: Int? = null,
)

// ── CSS px <-> Android unit conversions (WebView boundary) ────────────────

/**
 * Chat font size (sp) -> CSS px for the document body.
 *
 * CSS px and sp are both density-independent units, so only the user's
 * font-scale preference crosses the WebView boundary — never the screen
 * density. Converting through physical pixels (sp x density) instead would
 * inflate the formula by the density factor: 16sp chat text would inject
 * `font-size: 48px` on a density-3 screen and render ~3x too large.
 */
internal fun spFontToCssPx(fontSizeSp: Float, fontScale: Float): Int =
    (fontSizeSp * fontScale).roundToInt().coerceAtLeast(1)

/**
 * Document-reported height (CSS px) -> dp height for the Compose modifier.
 *
 * The document pins `width=device-width, initial-scale=1`, so at the default
 * WebView scale 1 CSS px covers exactly 1 dp; [webViewScale] (from
 * `WebView.scale`, non-1.0 only when zoomed) multiplies each CSS px by the
 * dp it occupies. Treating the reported CSS px as Android physical px and
 * dividing by density instead would shrink the block by the density factor:
 * 90 reported CSS px would become a 30dp view on a density-3 screen.
 */
internal fun cssPxToDp(reportedCssPx: Int, webViewScale: Float = 1f): Float =
    reportedCssPx * webViewScale.coerceAtLeast(0f)

internal fun buildMathDocument(spec: MathRenderSpec): String {
    // One substitution pass: markers inside user text are never interpreted.
    return Regex("__[A-Z]+__").replace(MATH_DOCUMENT_TEMPLATE) { marker ->
        when (marker.value) {
            "__COLOR__" -> "%06X".format(spec.textColorArgb and 0xFFFFFF)
            "__FONTSIZE__" -> spec.fontSizePx.coerceAtLeast(1).toString()
            "__DISPLAY__" -> spec.displayMode.toString()
            "__LATEX__" -> jsonStringLiteral(spec.latex)
            "__BODYCSS__" -> jsonStringLiteral(spec.bodyCss)
            "__RUNS__" -> spec.runs?.joinToString(prefix = "[", postfix = "]") { run ->
                """{"text":${jsonStringLiteral(run.text)},"math":${run.math},"css":${jsonStringLiteral(run.css)},"link":${run.link}}"""
            } ?: "null"
            else -> marker.value
        }
    }
}

/**
 * Minimal JSON string literal: escapes quotes, backslashes and control
 * characters, plus `<` (breaks `</script>` out of the inline script) and the
 * Unicode line/paragraph separators that are illegal in JS string literals.
 */
internal fun jsonStringLiteral(value: String): String {
    val out = StringBuilder(value.length + 2)
    out.append('"')
    for (ch in value) {
        when (ch) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            '\b' -> out.append("\\b")
            '\u000C' -> out.append("\\f")
            '<' -> out.append("\\u003c")
            '\u2028' -> out.append("\\u2028")
            '\u2029' -> out.append("\\u2029")
            else -> if (ch.code < 0x20) {
                out.append("\\u%04x".format(ch.code))
            } else {
                out.append(ch)
            }
        }
    }
    out.append('"')
    return out.toString()
}

private val MATH_DOCUMENT_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="katex.min.css">
<script src="katex.min.js"></script>
<style>
html, body { margin: 0; padding: 0; background: transparent; color: #__COLOR__; }
body { font-size: __FONTSIZE__px; line-height: 1.45; }
#math { overflow-x: auto; overflow-y: hidden; }
.math-prose { font-family: sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
.math-prose .inline-math { display: inline-block; max-width: 100%; overflow-x: auto; overflow-y: hidden; vertical-align: middle; white-space: normal; padding: 0.15em 0; }
.math-prose a { color: inherit; text-decoration: inherit; }
.katex-display { margin: 0.45em 0; }
.katex-fallback {
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-word;
  color: #cc0000;
  margin: 0;
}
</style>
</head>
<body>
<div id="math"></div>
<script>
(function () {
  var el = document.getElementById('math');
  var latex = __LATEX__;
  var displayMode = __DISPLAY__;
  var runs = __RUNS__;
  el.style.cssText = __BODYCSS__;
  function renderMath(latex, el, displayMode) {
    try {
      katex.render(latex, el, { displayMode: displayMode, throwOnError: true });
    } catch (error) {
      try {
        katex.render(latex, el, { displayMode: displayMode, strict: 'ignore', throwOnError: false });
      } catch (nested) {
        var pre = document.createElement('pre');
        pre.className = 'katex-fallback';
        pre.textContent = latex;
        pre.title = String(nested && nested.message ? nested.message : nested);
        el.textContent = '';
        el.appendChild(pre);
      }
    }
  }
  if (runs) {
    el.className = 'math-prose';
    runs.forEach(function (run) {
      var span = document.createElement(run.link === null ? 'span' : 'a');
      span.style.cssText = run.css;
      if (run.link !== null) {
        span.href = '#';
        span.addEventListener('click', function (event) {
          event.preventDefault();
          MathBridge.onLink(run.link);
        });
      }
      if (run.math) {
        span.className = 'inline-math';
        renderMath(run.text, span, false);
      } else {
        span.textContent = run.text;
      }
      el.appendChild(span);
    });
  } else {
    renderMath(latex, el, displayMode);
  }
  function report() {
    // Measure content, not the viewport (scrollHeight cannot shrink a view).
    var height = Math.ceil(el.getBoundingClientRect().height);
    if (height > 0) MathBridge.onHeight(height);
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(report).observe(el);
  }
  if (document.fonts) document.fonts.ready.then(report);
  window.addEventListener('load', report);
  setTimeout(report, 120);
})();
</script>
</body>
</html>
"""
