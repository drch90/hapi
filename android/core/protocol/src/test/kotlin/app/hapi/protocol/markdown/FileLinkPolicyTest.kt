package app.hapi.protocol.markdown

import org.commonmark.node.Link
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class FileLinkPolicyTest {
    private val workspace = "/root/workspace/hermes-lite-web"
    private val report = "$workspace/artifacts/review-20261011/review.md"

    @Test fun userReportLinkResolvesFromParsedMarkdown() {
        val document = MarkdownTransforms.parse("[完整报告与修复建议]($report) 已附上。")
        val link = document.firstChild.firstChild as Link
        assertEquals(FileLinkTarget(report), FileLinkPolicy.resolve(link.destination, workspace))
    }

    @Test fun relativeFilesKeepLineAndColumnHintsWhileDroppingUrlMetadata() {
        assertEquals(FileLinkTarget("docs/guide.md"), FileLinkPolicy.resolve("docs/guide.md#install"))
        assertEquals(FileLinkTarget("src/a.ts", 12, 7), FileLinkPolicy.resolve("src/a.ts:12:7?raw=1#L12"))
        assertEquals(FileLinkTarget("./readme.md"), FileLinkPolicy.resolve("./readme.md"))
        assertEquals(FileLinkTarget("sub/dir/img.png"), FileLinkPolicy.resolve("sub/dir/img.png?x=1"))
        assertEquals(FileLinkTarget(report, 42), FileLinkPolicy.resolve("$report:42", workspace))
    }

    @Test fun absoluteFilesRequireTheActualSessionWorkspace() {
        assertNull(FileLinkPolicy.resolve(report))
        assertNull(FileLinkPolicy.resolve(report, ""))
        assertNull(FileLinkPolicy.resolve(report, "/tmp/worktree"))
        assertNull(FileLinkPolicy.resolve("/repo/application/report.md", "/repo/app"))
        assertNull(FileLinkPolicy.resolve("/repo/APP/report.md", "/repo/app"))
        assertEquals(FileLinkTarget("/report.md"), FileLinkPolicy.resolve("/report.md", "/"))
        assertEquals(FileLinkTarget(report), FileLinkPolicy.resolve(report, "$workspace/"))
    }

    @Test fun absoluteDotSegmentsMustRemainInTheWorkspace() {
        val inside = "$workspace/docs/../report.md"
        assertEquals(FileLinkTarget(inside), FileLinkPolicy.resolve(inside, workspace))
        assertNull(FileLinkPolicy.resolve("$workspace/../../secret.md", workspace))
        assertNull(FileLinkPolicy.resolve("/../../root/report.md", "/root"))
        assertNull(FileLinkPolicy.resolve("$workspace/%2e%2e/secret.md", workspace))
        assertNull(FileLinkPolicy.resolve("$workspace/docs/%2e%2e/%2e%2e/secret.md", workspace))
    }

    @Test fun relativeParentTraversalAndRootedWindowsPathsStayInert() {
        for (path in listOf("../secret.md", "docs/../../secret.md", "%2e%2e/secret.md",
            "..%5csecret.md", "docs\\..\\secret.md", "\\secret.md", "\\\\server\\share\\file.md")) {
            assertNull(FileLinkPolicy.resolve(path, workspace), path)
        }
    }

    @Test fun encodedUnicodeSpacesAndPlusSignsReachTheViewerAsLiteralFilenames() {
        val expected = "$workspace/审查 报告+📄.md"
        assertEquals(FileLinkTarget(expected), FileLinkPolicy.resolve(
            "$workspace/%E5%AE%A1%E6%9F%A5%20报告+%F0%9F%93%84.md", workspace,
        ))
        val document = MarkdownTransforms.parse("[报告](<$expected>)")
        assertEquals(FileLinkTarget(expected), FileLinkPolicy.resolve(
            (document.firstChild.firstChild as Link).destination, workspace,
        ))
        assertEquals(FileLinkTarget("docs/a+b.md"), FileLinkPolicy.resolve("docs/a%2Bb.md"))
        assertEquals(FileLinkTarget("docs/100%.md"), FileLinkPolicy.resolve("docs/100%25.md"))
    }

    @Test fun encodedFilenameDelimitersAreNotUrlMetadataAndDecodeOnlyOnce() {
        assertEquals(FileLinkTarget("docs/a#b?c.md", 9), FileLinkPolicy.resolve("docs/a%23b%3Fc.md:9#anchor"))
        assertEquals(FileLinkTarget("docs/%2Fname.md"), FileLinkPolicy.resolve("docs/%252Fname.md"))
    }

    @Test fun malformedEncodingAndControlCharactersStayInert() {
        for (path in listOf("a%ZZ.md", "a%.md", "a%2.md", "a%C3.md", "a%C0%AF.md",
            "a%FF.md", "a%00.md", "a%0a.md", "a%7f.md", "a\nb.md")) {
            assertNull(FileLinkPolicy.resolve(path, workspace), path)
        }
    }

    @Test fun windowsPathsUseCaseInsensitiveDriveContainment() {
        val path = "c:\\Users\\Dev\\Project\\src\\File.kt"
        assertEquals(FileLinkTarget(path, 12, 3), FileLinkPolicy.resolve(
            "$path:12:3", "C:/users/dev/project",
        ))
        assertEquals(FileLinkTarget("C:/w/a.ts"), FileLinkPolicy.resolve("C:/w/a.ts", "c:/w/"))
        assertNull(FileLinkPolicy.resolve("C:/w/a.ts"))
        assertNull(FileLinkPolicy.resolve("D:/w/a.ts", "C:/w"))
        assertNull(FileLinkPolicy.resolve("C:/work-other/a.ts", "C:/work"))
        assertNull(FileLinkPolicy.resolve("C:/work/../a.ts", "C:/work"))
        assertNull(FileLinkPolicy.resolve("C:/../work/a.ts", "C:/work"))
        assertNull(FileLinkPolicy.resolve("C:/w/a", "C:/w"))
    }

    @Test fun tildeExpansionUsesTheSessionHomeAndStillChecksContainment() {
        assertEquals(FileLinkTarget(report), FileLinkPolicy.resolve(
            "~/workspace/hermes-lite-web/artifacts/review-20261011/review.md", workspace,
        ))
        assertEquals(FileLinkTarget("/home/dev/project/readme.md"), FileLinkPolicy.resolve(
            "~/project/readme.md", "/home/dev/project",
        ))
        assertEquals(FileLinkTarget("C:\\Users\\Dev\\project\\readme.md"), FileLinkPolicy.resolve(
            "~/project/readme.md", "C:\\Users\\Dev\\project",
        ))
        assertNull(FileLinkPolicy.resolve("~/secret.md", workspace))
        assertNull(FileLinkPolicy.resolve("~/project/readme.md", "/opt/project"))
        assertNull(FileLinkPolicy.resolve("~/project/readme.md"))
    }

    @Test fun urlsSessionReferencesUnknownExtensionsAndDirectoryTargetsKeepTheirOwnPolicy() {
        for (path in listOf("https://example.com/a.ts", "mailto:a@b.c", "vscode://file/a.ts",
            "javascript:a.ts", "data:text/a.md", "file:///root/a.md", "file%3A%2F%2F%2Froot/a.md",
            "//host/a.md", "%2F%2Fhost/a.md", "/sessions/session-id", "/settings",
            "#section", "?file=report.md", "docs/", "docs/unknown.extension", "example.org")) {
            assertNull(FileLinkPolicy.resolve(path, "/"), path)
        }
    }

    @Test fun invalidLineHintsDoNotPreventOpeningTheFile() {
        assertEquals(FileLinkTarget("a.ts"), FileLinkPolicy.resolve("a.ts:0"))
        assertEquals(FileLinkTarget("a.ts"), FileLinkPolicy.resolve("a.ts:99999999999999999999999"))
    }
}
