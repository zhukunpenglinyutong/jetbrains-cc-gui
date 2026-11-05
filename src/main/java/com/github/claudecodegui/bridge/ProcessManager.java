package com.github.claudecodegui.bridge;

import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Process manager.
 * Manages child processes related to the Claude SDK.
 */
public class ProcessManager implements AiDataProcessGate.IdleRuntime {

    private static final Logger LOG = Logger.getInstance(ProcessManager.class);
    private static final String CLAUDE_TEMP_DIR_NAME = "claude-agent-tmp";

    private final Map<String, Process> activeChannelProcesses = new ConcurrentHashMap<>();
    private final Map<Process, AiDataProcessGate.ProcessPermit> processPermits = new ConcurrentHashMap<>();
    private final Set<String> interruptedChannels = ConcurrentHashMap.newKeySet();
    private final AtomicInteger pendingStarts = new AtomicInteger();

    public ProcessManager() {
        AiDataProcessGate.getInstance().registerRuntime(this);
    }

    @Override
    public boolean hasActiveWork() {
        return pendingStarts.get() > 0 || activeChannelProcesses.values().stream().anyMatch(Process::isAlive)
                || processPermits.values().stream().anyMatch(AiDataProcessGate.ProcessPermit::hasLiveDescendants);
    }

    @Override
    public boolean stopIfIdle() {
        if (hasActiveWork()) {
            return false;
        }
        for (Map.Entry<Process, AiDataProcessGate.ProcessPermit> entry : processPermits.entrySet()) {
            releaseProcessPermit(entry.getKey());
        }
        return true;
    }

    /** Starts and registers an AI process only after data directory migration has yielded. */
    public Process startManagedProcess(String channelId, ProcessBuilder processBuilder) throws IOException {
        return startManagedProcess(channelId, processBuilder, () -> { });
    }

    /** Revalidates provider-specific admission after acquiring the shared permit, before spawning. */
    public Process startManagedProcess(String channelId, ProcessBuilder processBuilder, ProcessStartCheck check) throws IOException {
        pendingStarts.incrementAndGet();
        try {
            return startAdmittedProcess(channelId, processBuilder, check);
        } finally {
            pendingStarts.decrementAndGet();
        }
    }

    private Process startAdmittedProcess(String channelId, ProcessBuilder processBuilder, ProcessStartCheck check) throws IOException {
        AiDataProcessGate.ProcessPermit permit;
        try {
            permit = AiDataProcessGate.getInstance().acquireProcessPermit();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("AI_PROCESS_START_INTERRUPTED", error);
        }

        try {
            check.validate();
            Process process = processBuilder.start();
            permit.bindProcess(process);
            processPermits.put(process, permit);
            permit.whenReleased(() -> processPermits.remove(process, permit));
            registerProcess(channelId, process);
            return process;
        } catch (IOException | RuntimeException error) {
            permit.close();
            throw error;
        }
    }

    @FunctionalInterface
    public interface ProcessStartCheck {
        void validate() throws IOException;
    }

    /**
     * Generates a unique channel ID by appending a random UUID to {@code prefix}.
     *
     * <p>Use this when registering a short-lived child process whose channel
     * has no natural identifier (one-shot RPC calls, helper scripts, etc.).
     * A unique suffix is mandatory: see {@code CodexSDKBridge#getMcpServerTools}
     * (L10 fix) for why constant channel IDs corrupt the registry under
     * concurrent calls.
     */
    public static String newChannelId(String prefix) {
        return prefix + "-" + UUID.randomUUID();
    }

    /**
     * Registers an active process.
     */
    public void registerProcess(String channelId, Process process) {
        if (channelId != null && process != null) {
            AiDataProcessGate.ProcessPermit permit = processPermits.get(process);
            if (permit != null) {
                permit.bindProcess(process);
            }
            activeChannelProcesses.put(channelId, process);
            interruptedChannels.remove(channelId);
        }
    }

    /**
     * Unregisters an active process.
     */
    public void unregisterProcess(String channelId, Process process) {
        if (channelId != null) {
            activeChannelProcesses.remove(channelId, process);
        }
        releaseProcessPermit(process);
    }

    /**
     * Gets an active process by channel ID.
     */
    public Process getProcess(String channelId) {
        return activeChannelProcesses.get(channelId);
    }

    /**
     * Checks whether a channel was interrupted.
     */
    public boolean wasInterrupted(String channelId) {
        return channelId != null && interruptedChannels.remove(channelId);
    }

    /**
     * Interrupts a channel.
     * Uses platform-aware process termination to ensure the entire process tree
     * is properly terminated on Windows.
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

        // Use platform-aware process termination
        // Windows: uses taskkill /F /T to kill the process tree
        // Unix: uses standard destroy/destroyForcibly
        terminateManagedProcess(process);

        // Wait for the process to fully terminate
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
            releaseProcessPermit(process);
            // Verify the process has actually terminated
            if (process.isAlive()) {
                LOG.warn("[Interrupt] Warning: Process may still be alive for channel: " + channelId);
            } else {
                LOG.info("[Interrupt] Successfully terminated channel: " + channelId);
            }
        }
    }

    /**
     * Cleans up all active child processes.
     * Should be called when the plugin is unloaded or IDEA is shutting down.
     */
    public void cleanupAllProcesses() {
        LOG.info("[ProcessManager] Cleaning up all active processes...");
        int count = 0;

        for (Map.Entry<String, Process> entry : activeChannelProcesses.entrySet()) {
            String channelId = entry.getKey();
            Process process = entry.getValue();

            if (process != null && process.isAlive()) {
                LOG.info("[ProcessManager] Terminating process for channel: " + channelId);
                terminateManagedProcess(process);
                count++;
            }
        }

        for (Process process : processPermits.keySet()) {
            terminateManagedProcess(process);
            releaseProcessPermit(process);
        }
        activeChannelProcesses.clear();
        interruptedChannels.clear();

        // Clean up stale temp files on shutdown (safe for concurrent sessions)
        cleanupStaleTempFiles();

        LOG.info("[ProcessManager] Cleanup complete. Terminated " + count + " processes.");
    }

    /**
     * Gets the number of currently active processes.
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
     * Returns an immutable snapshot of the currently registered channel→process map.
     * Used by NodeProcessRegistry to enumerate live processes for the management panel.
     * Filters out dead processes inline so callers don't need to re-check isAlive().
     */
    public Map<String, Process> getActiveChannelSnapshot() {
        Map<String, Process> snapshot = new java.util.HashMap<>();
        for (Map.Entry<String, Process> entry : activeChannelProcesses.entrySet()) {
            Process process = entry.getValue();
            if (process != null && process.isAlive()) {
                snapshot.put(entry.getKey(), process);
            }
        }
        return snapshot;
    }

    /**
     * Waits for a process to terminate.
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
     * Prepares the Claude temporary directory.
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
     * Cleans up stale Claude cwd temp files older than the given threshold.
     * Called during IDE shutdown to prevent temp file accumulation
     * without interfering with concurrent sessions.
     */
    public void cleanupStaleTempFiles() {
        File tempDir = prepareClaudeTempDir();
        if (tempDir == null || !tempDir.exists()) {
            return;
        }
        File[] cwdFiles = tempDir.listFiles((dir, name) ->
            name.startsWith("claude-") && name.endsWith("-cwd"));
        if (cwdFiles == null || cwdFiles.length == 0) {
            return;
        }
        long staleThresholdMs = TimeUnit.HOURS.toMillis(24);
        long now = System.currentTimeMillis();
        int cleaned = 0;
        for (File file : cwdFiles) {
            if (now - file.lastModified() > staleThresholdMs) {
                if (!PlatformUtils.deleteWithRetry(file, 3)) {
                    try {
                        Files.deleteIfExists(file.toPath());
                    } catch (IOException e) {
                        LOG.error("[ProcessManager] Failed to delete stale temp cwd file: " + file.getAbsolutePath());
                    }
                }
                cleaned++;
            }
        }
        if (cleaned > 0) {
            LOG.info("[ProcessManager] Cleaned up " + cleaned + " stale temp cwd files.");
        }
    }

    private void releaseProcessPermit(Process process) {
        if (process == null) {
            return;
        }
        AiDataProcessGate.ProcessPermit permit = processPermits.get(process);
        if (permit != null) {
            permit.whenReleased(() -> processPermits.remove(process, permit));
            permit.close();
        }
    }

    private void terminateManagedProcess(Process process) {
        AiDataProcessGate.ProcessPermit permit = processPermits.get(process);
        if (permit == null) {
            PlatformUtils.terminateProcess(process);
        } else {
            permit.terminateProcessTree(3000L);
        }
    }
}
