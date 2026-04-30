package com.github.claudecodegui.handler.file;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class OpenFileHandlerTest {

    @Test
    public void parsesLineInfoForSimplePath() {
        OpenFileHandler.LineInfo lineInfo = OpenFileHandler.parseLineInfo("src/foo/bar.ts:42");

        assertEquals("src/foo/bar.ts", lineInfo.actualPath());
        assertEquals(42, lineInfo.lineNumber());
        assertEquals(-1, lineInfo.endLineNumber());
        assertTrue(lineInfo.hasLineInfo());
    }

    @Test
    public void parsesLineRangeInfo() {
        OpenFileHandler.LineInfo lineInfo = OpenFileHandler.parseLineInfo("Main.java:128-140");

        assertEquals("Main.java", lineInfo.actualPath());
        assertEquals(128, lineInfo.lineNumber());
        assertEquals(140, lineInfo.endLineNumber());
        assertTrue(lineInfo.hasLineInfo());
    }

    @Test
    public void rejectsColumnSyntax() {
        OpenFileHandler.LineInfo lineInfo = OpenFileHandler.parseLineInfo("E:\\project\\src\\Foo.java:42:15");

        assertEquals("E:\\project\\src\\Foo.java:42:15", lineInfo.actualPath());
        assertEquals(-1, lineInfo.lineNumber());
        assertEquals(-1, lineInfo.endLineNumber());
        assertFalse(lineInfo.hasLineInfo());
    }

    // ---------- extractFileName ----------

    @Test
    public void extractFileName_unixPath() {
        assertEquals("bar.ts", OpenFileHandler.extractFileName("/src/foo/bar.ts"));
    }

    @Test
    public void extractFileName_windowsPath() {
        assertEquals("bar.ts", OpenFileHandler.extractFileName("C:\\src\\foo\\bar.ts"));
    }

    @Test
    public void extractFileName_mixedSeparators() {
        // Mixed separators: should pick the last separator regardless of type.
        assertEquals("bar.ts", OpenFileHandler.extractFileName("C:\\src/foo\\bar.ts"));
        assertEquals("baz.ts", OpenFileHandler.extractFileName("/src\\foo/baz.ts"));
    }

    @Test
    public void extractFileName_noPath() {
        assertEquals("bar.ts", OpenFileHandler.extractFileName("bar.ts"));
    }

    @Test
    public void extractFileName_empty() {
        // Empty/blank input returns null per implementation contract.
        assertNull(OpenFileHandler.extractFileName(""));
        assertNull(OpenFileHandler.extractFileName("   "));
    }

    @Test
    public void extractFileName_nullInput() {
        assertNull(OpenFileHandler.extractFileName(null));
    }

    @Test
    public void extractFileName_trailingSeparatorReturnsOriginal() {
        // When path ends in a separator there is no filename after it; returns original string.
        assertEquals("foo/bar/", OpenFileHandler.extractFileName("foo/bar/"));
    }

    // ---------- extractPathSuffix ----------

    @Test
    public void extractPathSuffix_skipsSrcRoot() {
        // "src" is recognized as a common root prefix and skipped (single segment skip).
        assertEquals("main/java/foo/Bar.java",
                OpenFileHandler.extractPathSuffix("src/main/java/foo/Bar.java"));
    }

    @Test
    public void extractPathSuffix_skipsMainRoot() {
        assertEquals("kotlin/foo/Bar.kt",
                OpenFileHandler.extractPathSuffix("main/kotlin/foo/Bar.kt"));
    }

    @Test
    public void extractPathSuffix_skipsKotlinRoot() {
        assertEquals("foo/Bar.kt",
                OpenFileHandler.extractPathSuffix("kotlin/foo/Bar.kt"));
    }

    @Test
    public void extractPathSuffix_skipsJavaRoot() {
        assertEquals("foo/Bar.java",
                OpenFileHandler.extractPathSuffix("java/foo/Bar.java"));
    }

    @Test
    public void extractPathSuffix_skipsWebviewRoot() {
        assertEquals("src/utils/foo.ts",
                OpenFileHandler.extractPathSuffix("webview/src/utils/foo.ts"));
    }

    @Test
    public void extractPathSuffix_keepsFirstSegmentWhenNotCommonRoot() {
        // "lib" is not in the common-root list, so nothing is skipped.
        assertEquals("lib/utils/foo.ts",
                OpenFileHandler.extractPathSuffix("lib/utils/foo.ts"));
    }

    @Test
    public void extractPathSuffix_skipIsCaseInsensitive() {
        // Implementation lowercases the first segment before comparing.
        assertEquals("Main/java/Foo.java",
                OpenFileHandler.extractPathSuffix("SRC/Main/java/Foo.java"));
    }

    @Test
    public void extractPathSuffix_normalizesBackslashes() {
        assertEquals("main/java/foo/Bar.java",
                OpenFileHandler.extractPathSuffix("src\\main\\java\\foo\\Bar.java"));
    }

    @Test
    public void extractPathSuffix_singleSegment_returnsNull() {
        // Only one segment => no meaningful suffix.
        assertNull(OpenFileHandler.extractPathSuffix("Bar.java"));
    }

    @Test
    public void extractPathSuffix_twoSegments_doesNotSkip() {
        // segments.length == 2 means startIdx stays 0: full path returned.
        assertEquals("src/Bar.java",
                OpenFileHandler.extractPathSuffix("src/Bar.java"));
    }

    @Test
    public void extractPathSuffix_emptyOrBlank_returnsNull() {
        assertNull(OpenFileHandler.extractPathSuffix(""));
        assertNull(OpenFileHandler.extractPathSuffix("   "));
    }

    @Test
    public void extractPathSuffix_null_returnsNull() {
        assertNull(OpenFileHandler.extractPathSuffix(null));
    }
}
