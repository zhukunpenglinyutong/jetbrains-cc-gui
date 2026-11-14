package com.github.claudecodegui.util;

import org.junit.Test;

import java.nio.file.Path;

import static org.junit.Assert.assertEquals;

public class CodexHomeResolverTest {
    @Test
    public void nativeEnvironmentHomeWinsOverUserHome() {
        Path nativeHome = Path.of("native-codex-data").toAbsolutePath();
        assertEquals(nativeHome, CodexHomeResolver.resolve(" " + nativeHome + " ", "other-user-home"));
    }

    @Test
    public void absentNativeOverrideKeepsTheExistingUserHomeConvention() {
        Path fallback = Path.of("temporary-user-home", ".codex").toAbsolutePath();
        assertEquals(fallback, CodexHomeResolver.resolve(null, "temporary-user-home"));
        assertEquals(fallback, CodexHomeResolver.resolve(" ", "temporary-user-home"));
    }

    @Test
    public void mountedDriveOverrideUsesTheNativePlatformPathConvention() {
        Path expected = PlatformUtils.isWindows()
                ? Path.of("C:\\Users\\fixture\\.codex") : Path.of("/mnt/c/Users/fixture/.codex");
        assertEquals(expected.toAbsolutePath().normalize(),
                CodexHomeResolver.resolve(" /mnt/c/Users/fixture/.codex ", "unused-home"));
    }

    @Test
    public void mountedDriveRootAndUppercaseLettersAreHandled() {
        Path expected = PlatformUtils.isWindows() ? Path.of("D:\\") : Path.of("/mnt/D");
        assertEquals(expected.toAbsolutePath().normalize(), CodexHomeResolver.resolve("/mnt/D", "unused-home"));
    }
}
