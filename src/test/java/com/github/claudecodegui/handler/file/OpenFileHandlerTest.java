package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.diff.DiffFileOperations;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.project.Project;
import org.junit.Assume;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
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

    // ---------- isSafeExternalUrl ----------

    @Test
    public void isSafeExternalUrl_allowsHttpHttpsAndMailto() {
        assertTrue(OpenFileHandler.isSafeExternalUrl("https://www.npmmirror.com/package/@minimax-ai/code"));
        assertTrue(OpenFileHandler.isSafeExternalUrl("http://example.com/docs"));
        assertTrue(OpenFileHandler.isSafeExternalUrl("HTTPS://EXAMPLE.COM"));
        assertTrue(OpenFileHandler.isSafeExternalUrl("mailto:dev@example.com"));
    }

    @Test
    public void isSafeExternalUrl_rejectsDangerousSchemes() {
        assertFalse(OpenFileHandler.isSafeExternalUrl("file:///C:/Windows/System32/calc.exe"));
        assertFalse(OpenFileHandler.isSafeExternalUrl("file:///etc/passwd"));
        assertFalse(OpenFileHandler.isSafeExternalUrl("javascript:alert(1)"));
        assertFalse(OpenFileHandler.isSafeExternalUrl("jar:https://example.com/x.jar!/"));
        assertFalse(OpenFileHandler.isSafeExternalUrl("smb://attacker/share"));
    }

    @Test
    public void isSafeExternalUrl_rejectsBlankNullAndPaddedInput() {
        assertFalse(OpenFileHandler.isSafeExternalUrl(null));
        assertFalse(OpenFileHandler.isSafeExternalUrl(""));
        assertFalse(OpenFileHandler.isSafeExternalUrl("   "));
        // Scheme must start at the first character — no whitespace smuggling.
        assertFalse(OpenFileHandler.isSafeExternalUrl("  https://example.com"));
    }

    // ---------- pickBestFuzzyMatchPath / isSegmentAlignedSuffixMatch (#1682) ----------

    @Test
    public void pickBestFuzzyMatchPath_prefersSegmentAlignedSuffixMatch() {
        // Django-style project: several apps each have models.py. The message
        // references "blog/models.py" - only the blog app must win.
        List<String> candidates = List.of(
                "/proj/accounts/models.py",
                "/proj/blog/models.py",
                "/proj/myblog/models.py"
        );

        String best = OpenFileHandler.pickBestFuzzyMatchPath(candidates, "blog/models.py", List.of());

        assertEquals("/proj/blog/models.py", best);
    }

    @Test
    public void pickBestFuzzyMatchPath_prefersRecentlyOpenFileWhenNoSuffix() {
        // Bare filename "models.py" with two candidates and no path hint: the one
        // currently open in the editor must win over index iteration order.
        List<String> candidates = List.of(
                "/proj/accounts/models.py",
                "/proj/blog/models.py"
        );
        List<String> recentOpen = List.of("/proj/blog/models.py", "/proj/settings.py");

        String best = OpenFileHandler.pickBestFuzzyMatchPath(candidates, null, recentOpen);

        assertEquals("/proj/blog/models.py", best);
    }

    @Test
    public void pickBestFuzzyMatchPath_fallsBackToShortestPathDeterministically() {
        // No suffix, no open files: source-root heuristic is irrelevant for Django
        // apps, so the shortest path must win - deterministically, not by index order.
        List<String> candidates = List.of(
                "/proj/verylongappname/models.py",
                "/proj/app/models.py",
                "/proj/another/models.py"
        );

        String best = OpenFileHandler.pickBestFuzzyMatchPath(candidates, null, List.of());

        assertEquals("/proj/app/models.py", best);
    }

    @Test
    public void pickBestFuzzyMatchPath_returnsNullForEmptyCandidates() {
        assertNull(OpenFileHandler.pickBestFuzzyMatchPath(List.of(), "blog/models.py", List.of()));
    }

    @Test
    public void segmentAlignedSuffixMatch_rejectsEmbeddedSegment() {
        // "blog/models.py" must NOT match ".../myblog/models.py" - the occurrence
        // has to start on a '/' boundary (#1682).
        assertTrue(OpenFileHandler.isSegmentAlignedSuffixMatch(
                "/proj/blog/models.py", "blog/models.py"));
        assertFalse(OpenFileHandler.isSegmentAlignedSuffixMatch(
                "/proj/myblog/models.py", "blog/models.py"));
    }

    @Test
    public void segmentAlignedSuffixMatch_acceptsWindowsSeparators() {
        assertTrue(OpenFileHandler.isSegmentAlignedSuffixMatch(
                "D:\\proj\\blog\\models.py", "blog\\models.py"));
        assertFalse(OpenFileHandler.isSegmentAlignedSuffixMatch(
                "D:\\proj\\myblog\\models.py", "blog\\models.py"));
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

    @Test
    public void resolveDisplayPath_returnsAbsolutePathForExistingAbsoluteFileOutsideProjectRoot() throws Exception {
        Path tempDirectory = Files.createTempDirectory("ccg-path-tooltip");
        Path projectRoot = Files.createDirectory(tempDirectory.resolve("app"));
        Path outsideDirectory = Files.createDirectory(tempDirectory.resolve("app-secrets"));
        Path outsideFile = Files.writeString(outsideDirectory.resolve("secret.txt"), "secret");

        OpenFileHandler handler = new OpenFileHandler(createContext(projectRoot));

        String expected = outsideFile.toFile().getCanonicalFile().toString().replace('\\', '/');
        assertEquals(expected, handler.resolveDisplayPath(outsideFile.toString()));
    }

    @Test
    public void resolveDisplayPath_returnsAbsolutePathForMissingAbsoluteFileOutsideProjectRoot() throws Exception {
        Path tempDirectory = Files.createTempDirectory("ccg-path-tooltip");
        Path projectRoot = Files.createDirectory(tempDirectory.resolve("app"));
        Path missingOutsideFile = tempDirectory.resolve("app-secrets").resolve("missing.txt");

        OpenFileHandler handler = new OpenFileHandler(createContext(projectRoot));

        // File does not exist on disk → resolveFile returns null, falls back to
        // buildFallbackDisplayPath → relativizeToProjectRoot, which now returns
        // the canonical absolute path with forward slashes.
        String expected = missingOutsideFile.toFile().getCanonicalFile().toString().replace('\\', '/');
        assertEquals(expected, handler.resolveDisplayPath(missingOutsideFile.toString()));
    }

    @Test
    public void resolveDisplayPath_returnsAbsolutePathForMsysStyleAbsolutePathOutsideProjectRoot() throws Exception {
        Path tempDirectory = Files.createTempDirectory("ccg-path-tooltip");
        Path projectRoot = Files.createDirectory(tempDirectory.resolve("app"));
        OpenFileHandler handler = new OpenFileHandler(createContext(projectRoot));

        // MSYS-style paths are converted to Windows paths only on Windows.
        // Cross-platform check: result must be non-null and reference the same
        // file basename.
        String result = handler.resolveDisplayPath("/c/Users/alice/secret.txt");
        assertNotNull(result);
        assertTrue("Expected path to end with /secret.txt but was: " + result,
                result.endsWith("/secret.txt"));

        String mntResult = handler.resolveDisplayPath("/mnt/c/Users/alice/secret.txt");
        assertNotNull(mntResult);
        assertTrue("Expected path to end with /secret.txt but was: " + mntResult,
                mntResult.endsWith("/secret.txt"));
    }

    @Test
    public void resolveDisplayPath_returnsAbsolutePathForRelativeTraversalFallbackOutsideProjectRoot() throws Exception {
        Path tempDirectory = Files.createTempDirectory("ccg-path-tooltip");
        Path projectRoot = Files.createDirectory(tempDirectory.resolve("app"));
        OpenFileHandler handler = new OpenFileHandler(createContext(projectRoot));

        // "../outside.txt" resolves to <tempDirectory>/outside.txt — outside the
        // project root. The tooltip now surfaces the canonical absolute path.
        String expected = projectRoot.resolve("../outside.txt").normalize()
                .toFile().getCanonicalFile().toString().replace('\\', '/');
        assertEquals(expected, handler.resolveDisplayPath("../outside.txt"));
    }

    @Test
    public void resolveDisplayPath_mapsPhysicalPathThroughProjectSymlink() throws Exception {
        SymlinkProject symlinkProject = createProjectWithLinkedAssets();
        OpenFileHandler handler = new OpenFileHandler(createContext(symlinkProject.projectRoot()));

        assertTrue(Files.exists(symlinkProject.projectFile()));
        assertEquals("Assets/GameScripts/abc.cs", handler.resolveDisplayPath(symlinkProject.physicalFile().toString()));
    }

    @Test
    public void resolveFile_passesLinkedProjectPathToEditorForPhysicalAndRelativeLinks() throws Exception {
        SymlinkProject linked = createProjectWithLinkedAssets();
        OpenFileHandler handler = new OpenFileHandler(createContext(linked.projectRoot()));
        var resolver = OpenFileHandler.class.getDeclaredMethod("resolveFile", String.class);
        resolver.setAccessible(true);

        for (String href : List.of(linked.physicalFile().toString(), linked.projectFile().toString(),
                "Assets/GameScripts/abc.cs")) {
            OpenFileHandler.FileResolutionResult result =
                    (OpenFileHandler.FileResolutionResult) resolver.invoke(handler, href);
            assertNotNull(result);
            assertEquals(linked.projectFile(), result.file().toPath());
            assertTrue(Files.isSameFile(linked.physicalFile(), result.file().toPath()));
        }
    }

    @Test
    public void resolveFile_keepsUnlinkedExternalFilesOutsideProject() throws Exception {
        SymlinkProject linked = createProjectWithLinkedAssets();
        Path external = Files.writeString(linked.projectRoot().getParent().resolve("outside.cs"), "class Outside {}\n");
        OpenFileHandler handler = new OpenFileHandler(createContext(linked.projectRoot()));
        var resolver = OpenFileHandler.class.getDeclaredMethod("resolveFile", String.class);
        resolver.setAccessible(true);

        OpenFileHandler.FileResolutionResult result =
                (OpenFileHandler.FileResolutionResult) resolver.invoke(handler, external.toString());
        assertNotNull(result);
        assertEquals(external, result.file().toPath());
    }

    @Test
    public void diffPathValidation_allowsPhysicalPathThroughProjectSymlink() throws Exception {
        SymlinkProject symlinkProject = createProjectWithLinkedAssets();
        DiffFileOperations fileOperations = new DiffFileOperations(createContext(symlinkProject.projectRoot()));

        assertTrue(fileOperations.isPathWithinProject(symlinkProject.physicalFile().toString()));
    }

    @Test
    public void resolveDisplayPath_mapsMissingFileThroughLinkedParent() throws Exception {
        SymlinkProject linked = createProjectWithLinkedAssets();
        Path missingPhysicalFile = linked.physicalFile().resolveSibling("new.cs");
        OpenFileHandler handler = new OpenFileHandler(createContext(linked.projectRoot()));

        assertEquals("Assets/GameScripts/new.cs", handler.resolveDisplayPath(missingPhysicalFile.toString()));
    }

    @Test
    public void diffPathValidation_mapsNewLinkedFilesButRejectsUnlinkedSiblings() throws Exception {
        SymlinkProject linked = createProjectWithLinkedAssets();
        DiffFileOperations operations = new DiffFileOperations(createContext(linked.projectRoot()));
        Path newPhysicalFile = linked.physicalFile().resolveSibling("new.cs");
        Path expectedProjectFile = linked.projectFile().resolveSibling("new.cs");

        assertEquals(expectedProjectFile.toString().replace('\\', '/'),
                operations.toProjectPathIfPossible(newPhysicalFile.toString()));
        assertTrue(operations.isPathWithinProject(newPhysicalFile.toString()));
        assertFalse(operations.isPathWithinProject(linked.projectRoot().getParent().resolve("private.txt").toString()));
    }

    private static HandlerContext createContext(Path projectRoot) {
        Project project = (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class[]{Project.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "getBasePath" -> projectRoot.toString();
                    case "isDisposed" -> false;
                    case "toString" -> "TestProject";
                    default -> null;
                }
        );

        return new HandlerContext(project, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    private static SymlinkProject createProjectWithLinkedAssets() throws IOException {
        Path tempDirectory = Files.createTempDirectory("ccg-symlink-project");
        Path physicalRoot = Files.createDirectory(tempDirectory.resolve("Project"));
        Path physicalAssets = Files.createDirectories(physicalRoot.resolve("Assets").resolve("GameScripts"))
                .getParent();
        Path physicalFile = Files.writeString(
                physicalAssets.resolve("GameScripts").resolve("abc.cs"),
                "class Abc {}\n"
        );

        Path projectRoot = Files.createDirectory(physicalRoot.resolve("project_tuanjie"));
        Path projectAssets = projectRoot.resolve("Assets");
        createDirectorySymlinkOrSkip(projectAssets, physicalAssets);

        return new SymlinkProject(projectRoot, physicalFile, projectAssets.resolve("GameScripts").resolve("abc.cs"));
    }

    private static void createDirectorySymlinkOrSkip(Path link, Path target) {
        try {
            Files.createSymbolicLink(link, target);
        } catch (UnsupportedOperationException | IOException | SecurityException e) {
            if (!PlatformUtils.isWindows()) {
                Assume.assumeNoException(e);
                return;
            }
            // Directory junctions exercise the Windows path without requiring
            // administrator privileges or Developer Mode for symbolic links.
            try {
                Process process = new ProcessBuilder("cmd.exe", "/c", "mklink", "/J",
                        link.toString(), target.toString()).redirectErrorStream(true).start();
                if (!process.waitFor(5, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    throw new IOException("Timed out creating test junction");
                }
                Assume.assumeTrue("filesystem refuses directory junction creation", process.exitValue() == 0);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted while creating test junction", interrupted);
            } catch (IOException junctionError) {
                Assume.assumeNoException(junctionError);
            }
        }
    }

    private record SymlinkProject(Path projectRoot, Path physicalFile, Path projectFile) {
    }
}
