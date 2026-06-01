package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedWriter;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * 封装单个 CLI 进程的生命周期（stdin 写入 + 中断 + 销毁）。
 */
public class CliProcessHandle {

    private static final Logger LOG = Logger.getInstance(CliProcessHandle.class);

    private final Process process;
    private final BufferedWriter stdin;
    private final String label;
    private volatile boolean interrupted;

    public CliProcessHandle(Process process, String label) {
        this.process = process;
        this.label = label;
        this.stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
    }

    /** 向 stdin 写入一行 JSON（追加换行）。 */
    public synchronized void writeLine(String json) throws Exception {
        stdin.write(json);
        stdin.newLine();
        stdin.flush();
    }

    /** 关闭 stdin（通知 CLI 不再有输入）。 */
    public synchronized void closeStdin() {
        try {
            stdin.close();
        } catch (Exception ignored) {
        }
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

    /** 强制销毁进程并等待退出。 */
    public void destroy() {
        closeStdin();
        PlatformUtils.terminateProcess(process);
        try {
            if (process.isAlive()) {
                process.waitFor(5, TimeUnit.SECONDS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
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
