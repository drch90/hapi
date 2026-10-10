package app.hapi.companion.feature.chat.composer

import org.commonmark.node.Code
import org.commonmark.parser.Parser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class FileReferenceTest {
    @Test fun `path references preserve spaces Unicode backticks and Windows separators in Markdown`() {
        val parser = Parser.builder().build()
        for (path in listOf("docs/README.md", "docs/中文 notes.md", "C:\\work\\file.md",
            "docs/a`b.md", "`draft`", "``draft`", " spaced ")) {
            val paragraph = parser.parse(formatFileReference(path)).firstChild
            assertEquals(path, assertIs<Code>(paragraph.firstChild).literal)
        }
    }
}
