package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

/**
 * 封装单个 CLI 进程的生命周期（中断 + 状态查询）。
 */
public class CliProcessHandle {

    private static final Logger LOG = Logger.getInstance(CliProcessHandle.class);

    private final Process process;
    private final String label;
    private volatile boolean interrupted;

    public CliProcessHandle(Process process, String label) {
        this.process = process;
        this.label = label;
    }

    /** 中断：发送 SIGINT / taskkill，标记 interrupted。 */
    public void interrupt() {
        interrupted = true;
        LOG.info("[CliProcessHandle] Interrupting: " + label);
        PlatformUtils.terminateProcess(process);
        if (PlatformUtils.isWindows()) {
            PlatformUtils.cleanupOrphanedConhosts(process.pid());
        }
    }

    public boolean isAlive() {
        return process.isAlive();
    }

    public boolean wasInterrupted() {
        return interrupted;
    }

    public Process process() {
        return process;
    }
}
