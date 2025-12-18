package com.github.claudecodegui.bridge;

import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 进程管理器
 * 负责管理 Claude SDK 相关的子进程
 */
public class ProcessManager {

    private static final Logger LOG = Logger.getInstance(ProcessManager.class);
    private static final String CLAUDE_TEMP_DIR_NAME = "claude-agent-tmp";

    private final Map<String, Process> activeChannelProcesses = new ConcurrentHashMap<>();
    private final Set<String> interruptedChannels = ConcurrentHashMap.newKeySet();

    /**
     * 注册活动进程
     */
    public void registerProcess(String channelId, Process process) {
        if (channelId != null && process != null) {
            activeChannelProcesses.put(channelId, process);
            interruptedChannels.remove(channelId);
        }
    }

    /**
     * 注销活动进程
     */
    public void unregisterProcess(String channelId, Process process) {
        if (channelId != null) {
            activeChannelProcesses.remove(channelId, process);
        }
    }

    /**
     * 获取活动进程
     */
    public Process getProcess(String channelId) {
        return activeChannelProcesses.get(channelId);
    }

    /**
     * 检查通道是否被中断
     */
    public boolean wasInterrupted(String channelId) {
        return channelId != null && interruptedChannels.remove(channelId);
    }

    /**
     * 中断通道
     * 使用平台感知的进程终止方法，确保在 Windows 上正确终止子进程树
     */
    public void interruptChannel(String channelId) {
        if (channelId == null) {
            LOG.info("[Interrupt] ChannelId is null, nothing to interrupt");
            return;
        }

        Process process = activeChannelProcesses.get(channelId);
        if (process == null) {
            LOG.info("[Interrupt] No active process found for channel: " + channelId);
            return;
        }

        LOG.info("[Interrupt] Attempting to interrupt channel: " + channelId);
        interruptedChannels.add(channelId);

        // 使用平台感知的进程终止方法
        // Windows: 使用 taskkill /F /T 终止进程树
        // Unix: 使用标准的 destroy/destroyForcibly
        PlatformUtils.terminateProcess(process);

        // 等待进程完全终止
        try {
            if (process.isAlive()) {
                boolean terminated = process.waitFor(3, TimeUnit.SECONDS);
                if (!terminated) {
                    LOG.info("[Interrupt] Process still alive, force killing channel: " + channelId);
                    process.destroyForcibly();
                    process.waitFor(2, TimeUnit.SECONDS);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            activeChannelProcesses.remove(channelId, process);
            // 验证进程确实已终止
            if (process.isAlive()) {
                LOG.warn("[Interrupt] Warning: Process may still be alive for channel: " + channelId);
            } else {
                LOG.info("[Interrupt] Successfully terminated channel: " + channelId);
            }
        }
    }

    /**
     * 清理所有活动的子进程
     * 应在插件卸载或 IDEA 关闭时调用
     */
    public void cleanupAllProcesses() {
        LOG.info("[ProcessManager] Cleaning up all active processes...");
        int count = 0;

        for (Map.Entry<String, Process> entry : activeChannelProcesses.entrySet()) {
            String channelId = entry.getKey();
            Process process = entry.getValue();

            if (process != null && process.isAlive()) {
                LOG.info("[ProcessManager] Terminating process for channel: " + channelId);
                PlatformUtils.terminateProcess(process);
                count++;
            }
        }

        activeChannelProcesses.clear();
        interruptedChannels.clear();

        LOG.info("[ProcessManager] Cleanup complete. Terminated " + count + " processes.");
    }

    /**
     * 获取当前活动进程数量
     */
    public int getActiveProcessCount() {
        int count = 0;
        for (Process process : activeChannelProcesses.values()) {
            if (process != null && process.isAlive()) {
                count++;
            }
        }
        return count;
    }

    /**
     * 等待进程终止
     */
    public void waitForProcessTermination(Process process) {
        if (process == null) {
            return;
        }
        if (process.isAlive()) {
            try {
                process.waitFor(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * 准备 Claude 临时目录
     */
    public File prepareClaudeTempDir() {
        String baseTemp = System.getProperty("java.io.tmpdir");
        if (baseTemp == null || baseTemp.isEmpty()) {
            return null;
        }

        Path tempPath = Paths.get(baseTemp, CLAUDE_TEMP_DIR_NAME);
        try {
            Files.createDirectories(tempPath);
            return tempPath.toFile();
        } catch (IOException e) {
            LOG.error("[ProcessManager] Failed to prepare temp dir: " + tempPath + ", reason: " + e.getMessage());
            return null;
        }
    }

    /**
     * 快照 Claude cwd 文件
     */
    public Set<String> snapshotClaudeCwdFiles(File tempDir) {
        if (tempDir == null || !tempDir.exists()) {
            return Collections.emptySet();
        }
        File[] existing = tempDir.listFiles((dir, name) ->
            name.startsWith("claude-") && name.endsWith("-cwd"));
        if (existing == null || existing.length == 0) {
            return Collections.emptySet();
        }
        Set<String> snapshot = new HashSet<>();
        for (File file : existing) {
            snapshot.add(file.getName());
        }
        return snapshot;
    }

    /**
     * 清理 Claude 临时文件
     */
    public void cleanupClaudeTempFiles(File tempDir, Set<String> preserved) {
        if (tempDir == null || !tempDir.exists()) {
            return;
        }
        File[] leftovers = tempDir.listFiles((dir, name) ->
            name.startsWith("claude-") && name.endsWith("-cwd"));
        if (leftovers == null || leftovers.length == 0) {
            return;
        }
        for (File file : leftovers) {
            if (preserved != null && preserved.contains(file.getName())) {
                continue;
            }
            // 使用带重试机制的删除，处理 Windows 文件锁定问题
            if (!PlatformUtils.deleteWithRetry(file, 3)) {
                try {
                    Files.deleteIfExists(file.toPath());
                } catch (IOException e) {
                    LOG.error("[ProcessManager] Failed to delete temp cwd file: " + file.getAbsolutePath());
                }
            }
        }
    }
}
