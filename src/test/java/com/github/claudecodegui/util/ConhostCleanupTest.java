package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import org.junit.Test;

import static org.junit.Assert.*;

/**
 * 测试 conhost.exe 清理功能
 */
public class ConhostCleanupTest {

    private static final Logger LOG = Logger.getInstance(ConhostCleanupTest.class);

    /**
     * 测试基本的清理方法不会抛出异常
     */
    @Test
    public void testCleanupOrphanedConhostsDoesNotThrow() {
        if (!PlatformUtils.isWindows()) {
            LOG.info("Skipping Windows-specific test on non-Windows platform");
            return;
        }

        // 使用一个不存在的 PID 测试，不应该抛出异常
        try {
            PlatformUtils.cleanupOrphanedConhosts(999999);
            assertTrue(true); // 如果没有异常，测试通过
        } catch (Exception e) {
            fail("cleanupOrphanedConhosts should not throw exception: " + e.getMessage());
        }
    }

    /**
     * 测试全局清理方法不会抛出异常
     */
    @Test
    public void testCleanupAllPluginConhostsDoesNotThrow() {
        if (!PlatformUtils.isWindows()) {
            LOG.info("Skipping Windows-specific test on non-Windows platform");
            return;
        }

        try {
            PlatformUtils.cleanupAllPluginConhosts();
            assertTrue(true); // 如果没有异常，测试通过
        } catch (Exception e) {
            fail("cleanupAllPluginConhosts should not throw exception: " + e.getMessage());
        }
    }

    /**
     * 测试平台检测功能
     */
    @Test
    public void testPlatformDetection() {
        // 验证平台检测方法正常工作
        assertNotNull("Platform type should not be null", PlatformUtils.getPlatformType());

        if (PlatformUtils.isWindows()) {
            LOG.info("Running on Windows - conhost cleanup available");
            assertEquals("Should be Windows platform",
                PlatformUtils.PlatformType.WINDOWS, PlatformUtils.getPlatformType());
        } else {
            LOG.info("Not running on Windows - conhost cleanup not applicable");
            assertFalse("Should not be Windows", PlatformUtils.isWindows());
        }
    }

    /**
     * 测试进程管理器手动清理方法
     */
    @Test
    public void testProcessManagerManualCleanup() {
        if (!PlatformUtils.isWindows()) {
            LOG.info("Skipping Windows-specific test on non-Windows platform");
            return;
        }

        com.github.claudecodegui.bridge.ProcessManager processManager =
            new com.github.claudecodegui.bridge.ProcessManager();

        try {
            processManager.manualConhostCleanup();
            assertTrue(true); // 如果没有异常，测试通过
        } catch (Exception e) {
            fail("manualConhostCleanup should not throw exception: " + e.getMessage());
        }
    }
}