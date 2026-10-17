package com.github.claudecodegui.handler;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/** Verifies /diff reads staged, unstaged and Unicode untracked paths from the same repository. */
public class CodexWorkspaceDiffHandlerTest {
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    /** Drains a real child's stderr flood independently while preserving bounded stdout. */
    @Test
    public void drainsStderrBeforeStdoutEofWithoutBlockingTheChild() throws Exception {
        Path script = this.folder.newFile("flood.cjs").toPath();
        Files.writeString(script, "process.stderr.write('warning'.repeat(100000), () => process.stdout.write('workspace patch'));\n");
        var handler = new CodexWorkspaceDiffHandler(null,
                command -> new ProcessBuilder("node", script.toString()).start());
        var runGit = CodexWorkspaceDiffHandler.class.getDeclaredMethod("runGit", String.class, String[].class);
        runGit.setAccessible(true);
        Object result = runGit.invoke(handler, this.folder.getRoot().toString(), new String[]{"diff"});
        var exit = result.getClass().getDeclaredMethod("exitCode");
        var output = result.getClass().getDeclaredMethod("output");
        var errors = result.getClass().getDeclaredMethod("errors");
        var truncated = result.getClass().getDeclaredMethod("truncated");
        for (var accessor : java.util.List.of(exit, output, errors, truncated)) {
            accessor.setAccessible(true);
        }
        assertEquals(0, exit.invoke(result));
        assertEquals("workspace patch", output.invoke(result));
        assertEquals(512 * 1024, ((String) errors.invoke(result)).length());
        assertEquals(true, truncated.invoke(result));
    }

    @Test
    public void inspectCurrentWorktreeWithoutApplyingItsChanges() throws Exception {
        Path cwd = this.folder.newFolder("repo").toPath();
        this.git(cwd, "init");
        this.git(cwd, "config", "user.email", "fixture@example.invalid");
        this.git(cwd, "config", "user.name", "Fixture");
        Files.writeString(cwd.resolve("tracked.txt"), "baseline\n");
        this.git(cwd, "add", "tracked.txt");
        this.git(cwd, "commit", "-m", "fixture");
        Files.writeString(cwd.resolve("tracked.txt"), "staged\n");
        this.git(cwd, "add", "tracked.txt");
        Files.writeString(cwd.resolve("tracked.txt"), "unstaged\n");
        Files.writeString(cwd.resolve("未跟踪 space.txt"), "new\n");
        var method = CodexWorkspaceDiffHandler.class.getDeclaredMethod("collectDiff", String.class);
        method.setAccessible(true);
        JsonObject result = (JsonObject) method.invoke(new CodexWorkspaceDiffHandler(null), cwd.toString());
        assertTrue(result.get("staged").getAsString().contains("+staged"));
        assertTrue(result.get("unstaged").getAsString().contains("+unstaged"));
        assertEquals("未跟踪 space.txt", result.getAsJsonArray("untracked").get(0).getAsString());
        assertEquals("unstaged\n", Files.readString(cwd.resolve("tracked.txt")));
    }

    private void git(Path cwd, String... args) throws Exception {
        var command = new ArrayList<String>(Arrays.asList("git", "-C", cwd.toString()));
        command.addAll(Arrays.asList(args));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertEquals(output, 0, process.waitFor());
    }
}
