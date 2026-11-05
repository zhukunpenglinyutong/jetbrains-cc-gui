package com.github.claudecodegui.settings;

import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Path;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/** Best-effort detection of AI CLI processes not started by this plugin. */
public final class AiDataExternalProcessDetector {

    private static final Logger LOG = Logger.getInstance(AiDataExternalProcessDetector.class);
    private static final long SCAN_TIMEOUT_NANOS = TimeUnit.MILLISECONDS.toNanos(500L);

    public boolean hasRunningProcess() {
        long deadline = System.nanoTime() + SCAN_TIMEOUT_NANOS;
        try (Stream<ProcessHandle> processes = ProcessHandle.allProcesses()) {
            for (java.util.Iterator<ProcessHandle> iterator = processes.iterator(); iterator.hasNext();) {
                if (System.nanoTime() >= deadline) {
                    LOG.warn("Timed out inspecting external AI CLI processes before migration");
                    return true;
                }
                ProcessHandle handle = iterator.next();
                if (handle.pid() != ProcessHandle.current().pid() && looksLikeManagedCli(handle.info())) {
                    return true;
                }
            }
            return false;
        } catch (RuntimeException error) {
            LOG.warn("Unable to inspect external AI CLI processes: " + error.getMessage());
            return true;
        }
    }

    static boolean looksLikeManagedCli(ProcessHandle.Info info) {
        Optional<String> command = info.command();
        if (command.isEmpty()) {
            return false;
        }
        return looksLikeManagedCli(command.get(), info.arguments().orElse(new String[0]));
    }

    static boolean looksLikeManagedCli(String command, String[] arguments) {
        String executable = Path.of(command.replace('\\', '/')).getFileName().toString().toLowerCase(Locale.ROOT);
        if (executable.matches("(claude|codex|dsh)(\\.exe|\\.cmd|\\.bat)?")) {
            return true;
        }
        if (!executable.equals("node") && !executable.equals("node.exe")
                && !executable.equals("bun") && !executable.equals("bun.exe")) {
            return false;
        }
        for (String argument : arguments) {
            String normalized = argument.toLowerCase(Locale.ROOT).replace('\\', '/');
            if (normalized.contains("/@anthropic-ai/claude-code/")
                    || normalized.contains("/@openai/codex/")
                    || normalized.matches(".*/(claude|codex|dsh)(\\.js|\\.mjs|\\.cjs)")) {
                return true;
            }
        }
        return false;
    }
}
