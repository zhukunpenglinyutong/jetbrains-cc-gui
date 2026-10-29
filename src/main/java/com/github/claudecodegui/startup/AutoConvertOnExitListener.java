package com.github.claudecodegui.startup;

import com.github.claudecodegui.handler.history.HistoryAutoConvertService;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.ide.AppLifecycleListener;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Converts SDK-created Claude sessions to CLI-recognizable ones when the IDE exits,
 * so they show up in Claude Code's {@code /resume} list.
 *
 * <p>Opt-in: does nothing unless the user enabled the setting.
 *
 * <p><strong>Best effort, not a guarantee.</strong> The conversion runs on its own
 * daemon thread because a full scan of {@code ~/.claude/projects} can take a while
 * and must not hold the shutdown path open. Since a daemon thread keeps the JVM
 * from waiting, {@link #appWillBeClosed} therefore joins it for a bounded time
 * ({@link #CONVERSION_JOIN_TIMEOUT_MS}, on the EDT, hence kept short): the common
 * case — a handful of new sessions — finishes inside the timeout, and a slow
 * filesystem (network home, WSL, thousands of files) does not stall the quit dialog.
 * Whatever is still running when the JVM exits is killed mid-flight and converts on
 * the next IDE start, so a timeout degrades to "converts later", never to a corrupted
 * file: rewrites are atomic.
 *
 * <p>The IDE is already tearing down here, so every failure is logged and swallowed;
 * nothing is surfaced to the user.
 */
public class AutoConvertOnExitListener implements AppLifecycleListener {

    private static final Logger LOG = Logger.getInstance(AutoConvertOnExitListener.class);

    private static final String WORKER_THREAD_NAME = "ccgui-auto-convert-sessions";

    /**
     * How long the shutdown path waits for the conversion thread before giving up.
     *
     * <p>{@code appWillBeClosed} runs on the EDT, so this is a visible freeze of the
     * IDE window: every millisecond is added directly to how long "quitting" appears
     * to take. Two seconds is the compromise: long enough for the normal case — a
     * handful of freshly written sessions on a local disk, which is a few hundred
     * kilobytes of I/O — to finish invisibly, and short enough that a slow
     * filesystem (network home, WSL, thousands of sessions) still looks like a normal
     * quit rather than a hang. Anything beyond that is not worth the wait: exceeding
     * the budget is safe, because the daemon thread is abandoned and the remainder
     * converts on the next start.
     */
    static final long CONVERSION_JOIN_TIMEOUT_MS = 2_000L;

    @Override
    public void appWillBeClosed(boolean isRestart) {
        if (!isAutoConvertEnabled()) {
            return;
        }

        // The pooled executor is already winding down by the time the IDE closes, so a
        // task submitted there may never run. A dedicated daemon thread always starts,
        // and daemon=true guarantees it can never keep the JVM alive — which is exactly
        // why it has to be joined explicitly below.
        Thread worker = createWorkerThread();
        worker.start();

        long timeoutMs = getJoinTimeoutMs();
        if (!awaitWorkerCompletion(worker, timeoutMs)) {
            LOG.warn("[AutoConvertOnExit] Conversion did not finish within " + timeoutMs
                    + " ms; the remaining sessions convert on the next IDE start");
        }
    }

    /**
     * Read the opt-in flag defensively: a broken config must not break shutdown.
     */
    // VisibleForTesting
    boolean isAutoConvertEnabled() {
        try {
            return new CodemossSettingsService().getAutoConvertSessionsOnExit();
        } catch (Exception e) {
            LOG.warn("[AutoConvertOnExit] Cannot read the auto-convert setting: " + e.getMessage());
            return false;
        }
    }

    /**
     * Build the daemon worker. Split out from {@link #appWillBeClosed} so tests can
     * substitute a thread with a known duration without an IDE around it.
     */
    // VisibleForTesting
    Thread createWorkerThread() {
        Thread worker = new Thread(this::runConversion, WORKER_THREAD_NAME);
        worker.setDaemon(true);
        return worker;
    }

    /** Timeout applied to {@link #awaitWorkerCompletion}; overridable so tests stay fast. */
    // VisibleForTesting
    long getJoinTimeoutMs() {
        return CONVERSION_JOIN_TIMEOUT_MS;
    }

    private void runConversion() {
        try {
            new HistoryAutoConvertService().convertAllProjects();
        } catch (Exception e) {
            // Never surface a shutdown failure to the user.
            LOG.warn("[AutoConvertOnExit] Auto conversion failed: " + e.getMessage());
        }
    }

    /**
     * Wait up to {@code timeoutMs} for the worker, then report whether it finished.
     *
     * <p>Restores the interrupt flag instead of propagating: the caller is the IDE
     * shutdown path, where throwing would abort the quit and surface a dialog the
     * user cannot act on. An interrupt here also means the JVM is already tearing
     * down, so the pending conversion is simply lost and retried next start.
     *
     * @return true when the worker terminated within the timeout
     */
    // VisibleForTesting
    boolean awaitWorkerCompletion(Thread worker, long timeoutMs) {
        try {
            worker.join(timeoutMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            LOG.warn("[AutoConvertOnExit] Interrupted while waiting for the conversion to finish; "
                    + "the remaining sessions convert on the next IDE start");
            return false;
        }
        return !worker.isAlive();
    }
}
