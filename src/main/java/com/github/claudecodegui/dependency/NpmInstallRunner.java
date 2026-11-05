package com.github.claudecodegui.dependency;

import com.github.claudecodegui.util.PlatformUtils;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Runs one {@code npm install} attempt with a real wall-clock deadline.
 *
 * <p>Output is streamed line by line on a daemon thread, so {@code waitFor(timeout)}
 * on the calling thread is the only blocking step. Reading stdout to EOF first
 * (the old ordering) never reached the timeout while npm hung with the pipe open,
 * and the install lock held around it then blocked every later install.
 */
final class NpmInstallRunner {

    /** Grace period for the remaining output to arrive after npm exited or was killed. */
    static final long OUTPUT_DRAIN_MILLIS = 2000L;

    private NpmInstallRunner() {
    }

    /**
     * How the attempt ended.
     *
     * @param timedOut true when npm was terminated at the deadline
     * @param exitCode npm's exit code, or {@code -1} when it timed out
     */
    record Outcome(boolean timedOut, int exitCode) {
    }

    /**
     * Starts {@code builder}, forwards each output line to {@code lineSink} and waits for npm to exit.
     *
     * <p>{@code lineSink} is called from a reader thread while this method runs and never after it
     * returns, so the caller may keep appending to the same log without synchronisation.
     *
     * @param builder       the npm command; callers normally merge stderr into stdout
     * @param timeoutMillis hard deadline for npm to exit; the process tree is killed when it passes
     * @param lineSink      receives every output line until this method returns
     * @return the exit code, or a timed-out outcome
     * @throws IOException          if npm could not be started
     * @throws InterruptedException if the calling thread was interrupted; npm is killed first
     */
    static Outcome run(ProcessBuilder builder, long timeoutMillis, Consumer<String> lineSink)
            throws IOException, InterruptedException {
        Process process = builder.start();
        GatedSink sink = new GatedSink(lineSink);
        Thread reader = startReader(process.getInputStream(), sink);
        try {
            process.getOutputStream().close();
            if (!process.waitFor(timeoutMillis, TimeUnit.MILLISECONDS)) {
                PlatformUtils.terminateProcess(process);
                reader.join(OUTPUT_DRAIN_MILLIS);
                return new Outcome(true, -1);
            }
            // A child npm started may keep the inherited pipe open after npm itself exited;
            // the exit code is what matters, so stop waiting for the rest of the log.
            reader.join(OUTPUT_DRAIN_MILLIS);
            return new Outcome(false, process.exitValue());
        } finally {
            sink.close();
            if (process.isAlive()) {
                PlatformUtils.terminateProcess(process);
            }
        }
    }

    private static Thread startReader(InputStream input, GatedSink sink) {
        Thread reader = new Thread(() -> {
            try (BufferedReader lines = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                String line;
                while ((line = lines.readLine()) != null) {
                    sink.accept(line);
                }
            } catch (IOException ignored) {
                // The pipe closes when the process is killed; nothing left to forward.
            }
        }, "ccgui-npm-install-output");
        reader.setDaemon(true);
        reader.start();
        return reader;
    }

    /** Forwards lines until closed; closing waits for a line in flight, then drops the rest. */
    private static final class GatedSink {
        private final Consumer<String> target;
        private boolean open = true;

        GatedSink(Consumer<String> target) {
            this.target = target;
        }

        synchronized void accept(String line) {
            if (open) {
                target.accept(line);
            }
        }

        synchronized void close() {
            open = false;
        }
    }
}
