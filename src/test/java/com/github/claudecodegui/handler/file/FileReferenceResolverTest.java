package com.github.claudecodegui.handler.file;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class FileReferenceResolverTest {

    @Test
    public void resolvesAbsolutePathAndNormalizesSeparators() throws Exception {
        Path root = Files.createTempDirectory("file-ref-root");
        Path file = Files.createDirectories(root.resolve("src/main/java")).resolve("User.java");
        Files.writeString(file, "class User {}\n");

        FileReferenceResolver resolver = new FileReferenceResolver(null, root.toString(), root.toString());

        FileReferenceResolver.ResolveResult result =
                resolver.resolve(new FileReferenceResolver.ResolveRequest("ref-1", file.toString(), 12));

        assertTrue(result.resolved);
        assertEquals(file.toString().replace('\\', '/'), result.resolvedPath);
        assertEquals(12, result.line);
    }

    @Test
    public void resolvesAbsolutePathWithoutLineNumber() throws Exception {
        Path root = Files.createTempDirectory("file-ref-root-no-line");
        Path file = Files.createDirectories(root.resolve("src/main/java")).resolve("User.java");
        Files.writeString(file, "class User {}\n");

        FileReferenceResolver resolver = new FileReferenceResolver(null, root.toString(), root.toString());

        FileReferenceResolver.ResolveResult result =
                resolver.resolve(new FileReferenceResolver.ResolveRequest("ref-1", file.toString(), 0));

        assertTrue(result.resolved);
        assertEquals(file.toString().replace('\\', '/'), result.resolvedPath);
        assertEquals(0, result.line);
    }

    @Test
    public void resolvesRelativePathFromSessionCwdBeforeProjectBasePath() throws Exception {
        Path project = Files.createTempDirectory("file-ref-project");
        Path session = Files.createTempDirectory("file-ref-session");
        Path projectFile = Files.createDirectories(project.resolve("src")).resolve("User.java");
        Path sessionFile = Files.createDirectories(session.resolve("src")).resolve("User.java");
        Files.writeString(projectFile, "class ProjectUser {}\n");
        Files.writeString(sessionFile, "class SessionUser {}\n");

        FileReferenceResolver resolver = new FileReferenceResolver(null, session.toString(), project.toString());

        FileReferenceResolver.ResolveResult result =
                resolver.resolve(new FileReferenceResolver.ResolveRequest("ref-1", "src/User.java", 8));

        assertTrue(result.resolved);
        assertEquals(sessionFile.toString().replace('\\', '/'), result.resolvedPath);
    }

    @Test
    public void resolvesRelativePathFromProjectBaseWhenSessionCwdIsNull() throws Exception {
        Path project = Files.createTempDirectory("file-ref-project-null-session");
        Path projectFile = Files.createDirectories(project.resolve("src")).resolve("User.java");
        Files.writeString(projectFile, "class ProjectUser {}\n");

        FileReferenceResolver resolver = new FileReferenceResolver(null, null, project.toString());

        FileReferenceResolver.ResolveResult result =
                resolver.resolve(new FileReferenceResolver.ResolveRequest("ref-1", "src/User.java", 8));

        assertTrue(result.resolved);
        assertEquals(projectFile.toString().replace('\\', '/'), result.resolvedPath);
    }

    @Test
    public void sortsFilenameCandidatesWithSourceMainBeforeBuildOutputs() throws Exception {
        Path project = Files.createTempDirectory("file-ref-sort");
        Path targetFile = Files.createDirectories(project.resolve("target/generated")).resolve("Subject.java");
        Path testFile = Files.createDirectories(project.resolve("src/test/java")).resolve("Subject.java");
        Path mainFile = Files.createDirectories(project.resolve("src/main/java")).resolve("Subject.java");
        Files.writeString(targetFile, "class Target {}\n");
        Files.writeString(testFile, "class Test {}\n");
        Files.writeString(mainFile, "class Main {}\n");

        List<Path> sorted = FileReferenceResolver.sortCandidates(
                "Subject.java",
                project.toString(),
                List.of(targetFile, testFile, mainFile)
        );

        assertEquals(mainFile.toString().replace('\\', '/'), sorted.get(0).toString().replace('\\', '/'));
        assertEquals(testFile.toString().replace('\\', '/'), sorted.get(1).toString().replace('\\', '/'));
        assertEquals(targetFile.toString().replace('\\', '/'), sorted.get(2).toString().replace('\\', '/'));
    }

    @Test
    public void sortsEllipsisPathCandidatesByVisibleModuleSegment() throws Exception {
        Path project = Files.createTempDirectory("file-ref-sort-ellipsis");
        Path commonFile = Files.createDirectories(project.resolve(
                "workstudy-common/workstudy-common-service/src/main/java/com/workstudy/common"
        )).resolve("MessageDedupService.java");
        Path userFile = Files.createDirectories(project.resolve(
                "workstudy-user/workstudy-user-service/src/main/java/com/workstudy/user"
        )).resolve("MessageDedupService.java");
        Files.writeString(commonFile, "class Common {}\n");
        Files.writeString(userFile, "class User {}\n");

        List<Path> sorted = FileReferenceResolver.sortCandidates(
                "workstudy-user/.../MessageDedupService.java",
                project.toString(),
                List.of(commonFile, userFile)
        );

        assertEquals(userFile.toString().replace('\\', '/'), sorted.get(0).toString().replace('\\', '/'));
    }

    @Test
    public void sortsAmbiguousFilenameCandidatesByNearbyCodeContext() throws Exception {
        Path project = Files.createTempDirectory("file-ref-sort-context");
        Path nodeRegistry = Files.createDirectories(project.resolve("plugins/google_meet/node")).resolve("registry.py");
        Path toolsRegistry = Files.createDirectories(project.resolve("plugins/google_meet/tools")).resolve("registry.py");
        Files.writeString(nodeRegistry, fileWithLine(42, "    def _load(self) -> Dict[str, Any]:"));
        Files.writeString(toolsRegistry, fileWithLine(42, "def _module_registers_tools(module_path: Path) -> bool:"));

        List<Path> sorted = FileReferenceResolver.sortCandidates(
                "registry.py",
                project.toString(),
                List.of(nodeRegistry, toolsRegistry),
                "入口位于 registry.py:42，函数：\n"
                        + "def _module_registers_tools(module_path: Path) -> bool:\n"
                        + "    source = module_path.read_text(encoding=\"utf-8\")",
                42
        );

        assertEquals(toolsRegistry.toString().replace('\\', '/'), sorted.get(0).toString().replace('\\', '/'));
    }

    @Test
    public void unresolvedResultIncludesReason() throws Exception {
        Path project = Files.createTempDirectory("file-ref-missing");
        FileReferenceResolver resolver = new FileReferenceResolver(null, project.toString(), project.toString());

        FileReferenceResolver.ResolveResult result =
                resolver.resolve(new FileReferenceResolver.ResolveRequest("ref-1", "Missing.java", 10));

        assertFalse(result.resolved);
        assertEquals("not_found", result.reason);
    }

    private static String fileWithLine(int lineNumber, String targetLine) {
        List<String> lines = new ArrayList<>();
        for (int i = 1; i < lineNumber; i++) {
            lines.add("# filler " + i);
        }
        lines.add(targetLine);
        lines.add("# tail");
        return String.join("\n", lines) + "\n";
    }
}
