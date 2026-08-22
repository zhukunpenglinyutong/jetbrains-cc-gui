package com.github.claudecodegui.util;

import org.junit.Test;

import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Pins {@link PathUtils#guardWorkingDirectory(String, String)} — the cwd clamp
 * that keeps a provider daemon (e.g. the Grok ACP runtime) from being pointed
 * outside the project base. A wrong answer here is either a security hole
 * (daemon runs outside the project) or a broken UX (legit sub-directory cwd is
 * rejected), so every branch is covered.
 */
public class PathUtilsGuardWorkingDirectoryTest {

    private String tmpdir() {
        return Paths.get(System.getProperty("java.io.tmpdir")).toAbsolutePath().toString();
    }

    @Test
    public void returnsNullWhenNoProjectBaseToGuardAgainst() {
        // null base ⇒ caller has no anchor to clamp to, so it must keep its own cwd.
        assertNull(PathUtils.guardWorkingDirectory(Paths.get(tmpdir(), "anywhere").toString(), null));
        assertNull(PathUtils.guardWorkingDirectory(Paths.get(tmpdir(), "anywhere").toString(), ""));
    }

    @Test
    public void clampsMissingOrSentinelCwdToProjectBase() {
        String project = Paths.get(tmpdir(), "proj").toString();
        // The webview sends these sentinels when no cwd was chosen.
        assertEquals(project, PathUtils.guardWorkingDirectory(null, project));
        assertEquals(project, PathUtils.guardWorkingDirectory("", project));
        assertEquals(project, PathUtils.guardWorkingDirectory("undefined", project));
        assertEquals(project, PathUtils.guardWorkingDirectory("null", project));
    }

    @Test
    public void acceptsCwdEqualToProjectBase() {
        String project = Paths.get(tmpdir(), "proj").toString();
        assertEquals(project, PathUtils.guardWorkingDirectory(project, project));
    }

    @Test
    public void acceptsCwdNestedUnderProjectBase() {
        String project = Paths.get(tmpdir(), "proj").toString();
        String nested = Paths.get(project, "src", "deep").toString();
        assertEquals(nested, PathUtils.guardWorkingDirectory(nested, project));
    }

    @Test
    public void clampsCwdOutsideProjectBase() {
        String project = Paths.get(tmpdir(), "proj").toString();
        String outside = Paths.get(tmpdir(), "elsewhere").toString();
        assertEquals(project, PathUtils.guardWorkingDirectory(outside, project));
    }

    @Test
    public void clampsCwdThatEscapesViaDotDot() {
        // /tmp/proj/../elsewhere normalizes to /tmp/elsewhere — outside the project.
        String project = Paths.get(tmpdir(), "proj").toString();
        String escape = project + java.io.File.separator + ".." + java.io.File.separator + "elsewhere";
        assertEquals(project, PathUtils.guardWorkingDirectory(escape, project));
    }

    @Test
    public void acceptsCwdThatStaysInsideAfterNormalizing() {
        // /tmp/proj/sub/./file normalizes to /tmp/proj/sub/file — still inside — and
        // the original (non-normalized) cwd form is returned verbatim.
        String project = Paths.get(tmpdir(), "proj").toString();
        String inside = project + java.io.File.separator + "sub" + java.io.File.separator + "."
                + java.io.File.separator + "file";
        assertEquals(inside, PathUtils.guardWorkingDirectory(inside, project));
    }
}
