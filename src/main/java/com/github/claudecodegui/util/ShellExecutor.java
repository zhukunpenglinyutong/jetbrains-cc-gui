package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/**
 * Shell command execution utility.
 * Encapsulates common logic for process execution, timeout handling, and output filtering.
 */
public final class ShellExecutor {

    private static final Logger LOG = Logger.getInstance(ShellExecutor.class);

    /**
     * Default process timeout in seconds.
     */
    public static final int DEFAULT_TIMEOUT_SECONDS = 5;

    private ShellExecutor() {
        // Utility class, do not instantiate
    }

    /**
     * Execution result.
     */
    public static class ExecutionResult {
        private final boolean success;
        private final String output;
        private final List<String> allLines;
        private final List<String> filteredLines;

        private ExecutionResult(boolean success, String output, List<String> allLines, List<String> filteredLines) {
            this.success = success;
            this.output = output;
            this.allLines = allLines;
            this.filteredLines = filteredLines;
        }

        public boolean isSuccess() {
            return success;
        }

        public String getOutput() {
            return output;
        }

        public List<String> getAllLines() {
            return allLines;
        }

        public List<String> getFilteredLines() {
            return filteredLines;
        }

        public static ExecutionResult success(String output, List<String> allLines, List<String> filteredLines) {
            return new ExecutionResult(true, output, allLines, filteredLines);
        }

        public static ExecutionResult failure() {
            return new ExecutionResult(false, null, List.of(), List.of());
        }

        public static ExecutionResult timeout() {
            return new ExecutionResult(false, null, List.of(), List.of());
        }
    }

    /**
     * Execute a shell command and return the first valid output line.
     *
     * @param command    the command as a list of arguments
     * @param lineFilter line filter; returns true if the line is valid
     * @param logPrefix  prefix for log messages
     * @return the execution result
     */
    public static ExecutionResult execute(List<String> command, Predicate<String> lineFilter, String logPrefix) {
        return execute(command, lineFilter, logPrefix, DEFAULT_TIMEOUT_SECONDS, true);
    }

    /**
     * Execute a shell command and return the result.
     *
     * @param command          the command as a list of arguments
     * @param lineFilter       line filter; returns true if the line is valid
     * @param logPrefix        prefix for log messages
     * @param timeoutSeconds   timeout in seconds
     * @param useInteractive   whether to use interactive shell configuration (sets TERM=dumb)
     * @return the execution result
     */
    public static ExecutionResult execute(
            List<String> command,
            Predicate<String> lineFilter,
            String logPrefix,
            int timeoutSeconds,
            boolean useInteractive
    ) {
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            if (useInteractive) {
                // Set TERM=dumb to suppress extra output from interactive shells (color codes, prompts, etc.)
                pb.environment().put("TERM", "dumb");
            }
            pb.redirectErrorStream(true);

            Process process = pb.start();

            // Wait for the process to complete (with timeout) to avoid blocking on readLine
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                LOG.debug(logPrefix + " command timed out");
                process.destroyForcibly();
                return ExecutionResult.timeout();
            }

            // Process has completed, now safe to read output
            List<String> allLines = new ArrayList<>();
            List<String> filteredLines = new ArrayList<>();
            String validOutput = null;

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    allLines.add(trimmed);

                    if (lineFilter.test(trimmed)) {
                        validOutput = trimmed;
                        // Return on the first valid line
                        break;
                    } else if (!trimmed.isEmpty()) {
                        // Record filtered non-empty lines for debugging
                        filteredLines.add(trimmed);
                    }
                }

                // Read remaining lines
                while ((line = reader.readLine()) != null) {
                    allLines.add(line.trim());
                }
            }

            // Log filtered lines at DEBUG level
            if (!filteredLines.isEmpty() && LOG.isDebugEnabled()) {
                LOG.debug(logPrefix + " filtered lines: " + filteredLines);
            }

            if (validOutput != null) {
                return ExecutionResult.success(validOutput, allLines, filteredLines);
            }

            return ExecutionResult.failure();
        } catch (Exception e) {
            LOG.debug(logPrefix + " execution failed: " + e.getMessage());
            return ExecutionResult.failure();
        }
    }

    /**
     * Execute a shell command and return the last valid output line (useful for retrieving environment variables).
     *
     * @param command          the command as a list of arguments
     * @param lineFilter       line filter; returns true if the line is valid
     * @param logPrefix        prefix for log messages
     * @param timeoutSeconds   timeout in seconds
     * @return the execution result
     */
    public static ExecutionResult executeAndGetLast(
            List<String> command,
            Predicate<String> lineFilter,
            String logPrefix,
            int timeoutSeconds
    ) {
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            // Set TERM=dumb to suppress extra output from interactive shells
            pb.environment().put("TERM", "dumb");
            pb.redirectErrorStream(true);

            Process process = pb.start();

            // Wait for the process to complete (with timeout)
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                LOG.debug(logPrefix + " command timed out");
                process.destroyForcibly();
                return ExecutionResult.timeout();
            }

            // Read all output, keeping the last valid value
            List<String> allLines = new ArrayList<>();
            List<String> filteredLines = new ArrayList<>();
            String lastValidValue = null;

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    allLines.add(trimmed);

                    if (lineFilter.test(trimmed)) {
                        lastValidValue = trimmed;
                    } else if (!trimmed.isEmpty()) {
                        filteredLines.add(trimmed);
                    }
                }
            }

            // Log filtered lines at DEBUG level
            if (!filteredLines.isEmpty() && LOG.isDebugEnabled()) {
                LOG.debug(logPrefix + " filtered lines: " + filteredLines);
            }

            if (lastValidValue != null) {
                return ExecutionResult.success(lastValidValue, allLines, filteredLines);
            }

            return ExecutionResult.failure();
        } catch (Exception e) {
            LOG.debug(logPrefix + " execution failed: " + e.getMessage());
            return ExecutionResult.failure();
        }
    }

    /**
     * Create a default filter for interactive shell output.
     * Filters out common shell prompts, login messages, etc.
     *
     * @return the line filter
     */
    public static Predicate<String> createShellOutputFilter() {
        return line -> {
            if (line == null || line.isEmpty()) {
                return false;
            }
            // Skip common shell output noise
            return !line.startsWith("[") &&         // Skip MOTD brackets
                   !line.startsWith("%") &&         // Skip zsh prompts
                   !line.startsWith(">") &&         // Skip continuation prompts
                   !line.contains("Last login");    // Skip login messages
        };
    }

    /**
     * Create a filter for Node.js paths.
     *
     * @return the line filter
     */
    public static Predicate<String> createNodePathFilter() {
        return line -> {
            if (line == null || line.isEmpty()) {
                return false;
            }
            // A valid node path should start with /, end with /node, and not contain error messages
            return line.startsWith("/") &&
                   !line.contains("not found") &&
                   line.endsWith("/node");
        };
    }
}
