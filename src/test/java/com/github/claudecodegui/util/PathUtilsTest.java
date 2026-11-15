package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PathUtilsTest {

    @Test
    public void remoteUncPathsAreDetectedInBothSlashForms() {
        assertTrue(PathUtils.isRemoteUncPath("//host/share/a.cs"));
        assertTrue(PathUtils.isRemoteUncPath("\\\\host\\share\\a.cs"));
        assertTrue(PathUtils.isRemoteUncPath("\\\\?\\UNC\\host\\share\\a.cs"));
        assertTrue(PathUtils.isRemoteUncPath("//wsl.localhost.evil.example/share/a.cs"));
    }

    @Test
    public void wslAndLocalPathsAreNotRemoteUnc() {
        assertFalse(PathUtils.isRemoteUncPath("\\\\wsl.localhost\\Ubuntu\\home\\a.cs"));
        assertFalse(PathUtils.isRemoteUncPath("//wsl$/Ubuntu/home/a.cs"));
        assertFalse(PathUtils.isRemoteUncPath("C:\\project\\a.cs"));
        assertFalse(PathUtils.isRemoteUncPath("/home/user/a.cs"));
        assertFalse(PathUtils.isRemoteUncPath("src/a.cs"));
        assertFalse(PathUtils.isRemoteUncPath(null));
    }
}
