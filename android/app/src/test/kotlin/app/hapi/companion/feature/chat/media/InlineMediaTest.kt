package app.hapi.companion.feature.chat.media

import kotlin.test.Test
import kotlin.test.assertEquals

class InlineMediaTest {
    @Test fun mediaTypesPreserveLegacyImagesAndTreatUnknownTypesAsDownloads() {
        assertEquals(InlineMediaKind.Image, inlineMediaKind(null))
        assertEquals(InlineMediaKind.Image, inlineMediaKind("image/svg+xml"))
        assertEquals(InlineMediaKind.Video, inlineMediaKind("Video/MP4; codecs=avc1"))
        assertEquals(InlineMediaKind.Audio, inlineMediaKind("audio/wav"))
        assertEquals(InlineMediaKind.File, inlineMediaKind("application/pdf"))
        assertEquals(InlineMediaKind.File, inlineMediaKind("application/octet-stream"))
        assertEquals(InlineMediaKind.File, inlineMediaKind("text/html"))
    }

    @Test fun suggestedFilenamesCannotContainPathsOrControlCharacters() {
        assertEquals("report.pdf", mediaFileName("../../report.pdf"))
        assertEquals("report.zip", mediaFileName("C:\\files\\report.zip"))
        assertEquals("report.txt", mediaFileName("report\n.txt"))
        assertEquals("download", mediaFileName(".."))
        assertEquals("download", mediaFileName(""))
    }
}
