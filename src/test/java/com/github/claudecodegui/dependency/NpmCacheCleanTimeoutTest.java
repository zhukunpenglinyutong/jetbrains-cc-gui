package com.github.claudecodegui.dependency;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;

/**
 * {@code npm cache clean} runs while the install lock is held, so a stalled one
 * must not outlive its deadline (a locked cache file on Windows keeps it hanging).
 */
public class NpmCacheCleanTimeoutTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void aStalledCacheCleanGivesUpAtItsDeadline() throws Exception {
        assumeFalse("POSIX shell fixture", PlatformUtils.isWindows());
        Path npm = temporary.getRoot().toPath().resolve("npm");
        Files.writeString(npm, "#!/bin/sh\necho 'npm warn using --force'\nsleep 60\n", StandardCharsets.UTF_8);
        assertTrue(npm.toFile().setExecutable(true));

        long started = System.nanoTime();
        boolean cleaned = NpmPermissionHelper.cleanNpmCache(npm.toString(), 1500);

        assertFalse(cleaned);
        assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started) < 10);
    }

    @Test public void aSuccessfulCacheCleanIsReported() throws Exception {
        assumeFalse("POSIX shell fixture", PlatformUtils.isWindows());
        Path npm = temporary.getRoot().toPath().resolve("npm");
        Files.writeString(npm, "#!/bin/sh\necho 'npm warn using --force' >&2\nexit 0\n", StandardCharsets.UTF_8);
        assertTrue(npm.toFile().setExecutable(true));

        assertTrue(NpmPermissionHelper.cleanNpmCache(npm.toString(), 10_000));
    }
}
