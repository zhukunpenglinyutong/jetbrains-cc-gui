package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Runs a short-lived Node.js child under {@link ProcessManager} supervision with
 * a real wall-clock deadline.
 *
 * <p>Stdout is drained and stdin (if any) is written on daemon threads, so
 * {@code waitFor(timeout)} on the calling thread is the only blocking step. The
 * older read-stdout-to-EOF-then-wait ordering never reached its timeout when the
 * child hung with the pipe open, and a synchronous stdin write blocked forever
 * once the payload outgrew the pipe buffer of a child that never read it.
 *
 * <p>Output is only returned once the reader has hit EOF: if stdout is still open
 * shortly after the child exited (e.g. a grandchild inherited it), the call fails
 * instead of handing back output that may be cut short.
 */
public final class NodeProcessRunner {

    private static final Logger LOG = Logger.getInstance(NodeProcessRunner.class);

    /** Grace period for the reader to reach EOF after the child exited. */
    static final long OUTPUT_DRAIN_MILLIS = 2000L;

    private NodeProcessRunner() {
    }

    /** Exit code and complete stdout of a finished child. */
    public static final class Result {
        private final int exitCode;
        private final String output;

        Result(int exitCode, String output) {
            this.exitCode = exitCode;
            this.output = output;
        }

        public int exitCode() {
            return exitCode;
        }

        /** Stdout with every line terminated by {@code '\n'}. */
        public String output() {
            return output;
        }

        /**
         * The last non-empty line of output, where the services print their JSON
         * result. Kept as the callers had it: {@code ""} when the child printed
         * nothing, {@code "{}"} when it printed only line breaks.
         */
        public String lastLine() {
            String[] lines = output.split("\n");
            return lines.length > 0 ? lines[lines.length - 1] : "{}";
        }
    }

    /**
     * Starts {@code pb}, feeds it {@code stdinData} and waits for it to exit.
     *
     * @param pb             configured process builder; callers normally merge stderr into stdout
     * @param processManager registry the child is registered with while it runs
     * @param label          prefix for the channel id and the I/O thread names
     * @param stdinData      written to stdin and then closed, or {@code null} to leave stdin untouched
     * @param timeoutSeconds hard deadline for the child to exit
     * @throws TimeoutException if the child did not exit in time; it has been terminated
     * @throws IOException      if the child could not be started or its stdout was not fully read
     */
    public static Result run(
            ProcessBuilder pb,
            ProcessManager processManager,
            String label,
            String stdinData,
            long timeoutSeconds
    ) throws IOException, InterruptedException, TimeoutException {
        String channelId = ProcessManager.newChannelId(label);
        Process process = null;
        try {
            process = pb.start();
            processManager.registerProcess(channelId, process);

            CompletableFuture<String> stdout = startStdoutReader(process, label);
            if (stdinData != null) {
                startStdinWriter(process, stdinData, label);
            }

            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                PlatformUtils.terminateProcess(process);
                throw new TimeoutException("Node.js process timed out after " + timeoutSeconds + " seconds");
            }
            return new Result(process.exitValue(), awaitOutput(stdout));
        } finally {
            if (process != null) {
                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }
                processManager.unregisterProcess(channelId, process);
            }
        }
    }

    private static String awaitOutput(CompletableFuture<String> stdout) throws IOException, InterruptedException {
        try {
            return stdout.get(OUTPUT_DRAIN_MILLIS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            throw new IOException("Node.js process exited but its stdout was still open after "
                    + OUTPUT_DRAIN_MILLIS + " ms; refusing to use possibly truncated output");
        } catch (ExecutionException e) {
            throw new IOException("Failed to read Node.js process output: " + e.getCause().getMessage(), e.getCause());
        }
    }

    private static CompletableFuture<String> startStdoutReader(Process process, String label) {
        CompletableFuture<String> stdout = new CompletableFuture<>();
        startDaemon(label + "-stdout-reader", () -> {
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append('\n');
                }
                stdout.complete(output.toString());
            } catch (IOException e) {
                // Expected when the child is killed on timeout.
                LOG.debug("[" + label + "] stdout reader stopped: " + e.getMessage());
                stdout.completeExceptionally(e);
            } catch (RuntimeException | Error e) {
                // e.g. OutOfMemoryError on a huge payload: surface it rather than
                // leaving the caller to report a misleading timeout.
                LOG.warn("[" + label + "] stdout reader failed", e);
                stdout.completeExceptionally(e);
            }
        });
        return stdout;
    }

    private static void startStdinWriter(Process process, String stdinData, String label) {
        byte[] payload = stdinData.getBytes(StandardCharsets.UTF_8);
        startDaemon(label + "-stdin-writer", () -> {
            try (OutputStream stdin = process.getOutputStream()) {
                stdin.write(payload);
            } catch (IOException e) {
                // Broken pipe: the child exited or was killed before consuming all of
                // stdin. The exit code / timeout on the calling thread reports that.
                LOG.debug("[" + label + "] stdin writer stopped: " + e.getMessage());
            }
        });
    }

    private static void startDaemon(String name, Runnable task) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        thread.start();
    }
}
