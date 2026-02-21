package com.github.claudecodegui.session;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.handler.HandlerContext;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.MessageJsonConverter;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.Alarm;

import java.util.List;

/**
 * Coalesces streaming message updates to throttle webview pushes.
 * Batches rapid onMessageUpdate callbacks into periodic UI refreshes
 * to avoid overwhelming the JCEF browser.
 */
public class StreamMessageCoalescer {

    private static final Logger LOG = Logger.getInstance(StreamMessageCoalescer.class);
    private static final int UPDATE_INTERVAL_MS = 50;

    private final Object lock = new Object();
    private final Alarm updateAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    private volatile boolean streamActive = false;
    private volatile boolean updateScheduled = false;
    private volatile long lastUpdateAtMs = 0L;
    private volatile long updateSequence = 0L;
    private volatile List<ClaudeSession.Message> pendingMessages = null;
    private volatile List<ClaudeSession.Message> lastSnapshot = null;

    private final JsCallbackTarget callbackTarget;

    /**
     * Callback interface to push data to the webview.
     */
    public interface JsCallbackTarget {
        void callJavaScript(String functionName, String... args);
        JBCefBrowser getBrowser();
        boolean isDisposed();
        HandlerContext getHandlerContext();
    }

    public StreamMessageCoalescer(JsCallbackTarget callbackTarget) {
        this.callbackTarget = callbackTarget;
    }

    /**
     * Enqueue a message update for coalesced delivery.
     */
    public void enqueue(List<ClaudeSession.Message> messages) {
        if (callbackTarget.isDisposed()) {
            return;
        }
        // Defensive copy: the caller's list may be mutated on another thread,
        // so we snapshot it here to guarantee a consistent read in sendToWebView.
        final List<ClaudeSession.Message> snapshot = List.copyOf(messages);
        synchronized (lock) {
            pendingMessages = snapshot;
        }
        schedulePush();
    }

    /**
     * Notify that a stream has started.
     */
    public void onStreamStart() {
        synchronized (lock) {
            streamActive = true;
        }
    }

    /**
     * Notify that a stream has ended.
     */
    public void onStreamEnd() {
        synchronized (lock) {
            streamActive = false;
        }
    }

    /**
     * Reset stream state (e.g., on new session creation).
     */
    public void resetStreamState() {
        synchronized (lock) {
            streamActive = false;
        }
    }

    public boolean isStreamActive() {
        return streamActive;
    }

    /**
     * Flush any pending messages immediately and optionally run a callback afterwards.
     */
    public void flush(Runnable afterFlushOnEdt) {
        if (callbackTarget.isDisposed()) {
            return;
        }

        final List<ClaudeSession.Message> snapshot;
        final long sequence;
        synchronized (lock) {
            updateAlarm.cancelAllRequests();
            updateScheduled = false;
            snapshot = pendingMessages != null ? pendingMessages : lastSnapshot;
            pendingMessages = null;
            sequence = ++updateSequence;
        }

        if (snapshot == null) {
            if (afterFlushOnEdt != null) {
                ApplicationManager.getApplication().invokeLater(afterFlushOnEdt);
            }
            return;
        }

        sendToWebView(snapshot, sequence, afterFlushOnEdt);
    }

    /**
     * Dispose internal resources.
     */
    public void dispose() {
        try {
            updateAlarm.cancelAllRequests();
            updateAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose stream message update alarm: " + e.getMessage());
        }
    }

    private void schedulePush() {
        if (callbackTarget.isDisposed()) {
            return;
        }

        final int delayMs;
        synchronized (lock) {
            if (updateScheduled) {
                return;
            }
            long elapsed = System.currentTimeMillis() - lastUpdateAtMs;
            delayMs = (int) Math.max(0L, UPDATE_INTERVAL_MS - elapsed);
            updateScheduled = true;
            ++updateSequence;
        }

        updateAlarm.addRequest(() -> {
            final List<ClaudeSession.Message> snapshot;
            final long sequence;
            synchronized (lock) {
                updateScheduled = false;
                lastUpdateAtMs = System.currentTimeMillis();
                snapshot = pendingMessages;
                pendingMessages = null;
                sequence = updateSequence;
            }

            if (callbackTarget.isDisposed()) {
                return;
            }

            if (snapshot != null) {
                sendToWebView(snapshot, sequence, null);
            }

            boolean hasPending;
            synchronized (lock) {
                hasPending = pendingMessages != null;
            }
            if (hasPending && !callbackTarget.isDisposed()) {
                schedulePush();
            }
        }, delayMs);
    }

    private void sendToWebView(
            List<ClaudeSession.Message> messages,
            long sequence,
            Runnable afterSendOnEdt
    ) {
        // Keep the snapshot for potential re-flush after webview reload/recreate
        synchronized (lock) {
            lastSnapshot = messages;
        }

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            final String escapedMessagesJson;
            try {
                escapedMessagesJson = JsUtils.escapeJs(MessageJsonConverter.convertMessagesToJson(messages));
            } catch (Exception e) {
                LOG.warn("Failed to serialize messages for streaming update: " + e.getMessage(), e);
                if (afterSendOnEdt != null) {
                    ApplicationManager.getApplication().invokeLater(afterSendOnEdt);
                }
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                if (callbackTarget.isDisposed()) {
                    return;
                }

                synchronized (lock) {
                    if (sequence != updateSequence) {
                        return;
                    }
                }

                callbackTarget.callJavaScript("updateMessages", escapedMessagesJson);
                MessageJsonConverter.pushUsageUpdateFromMessages(
                        messages,
                        callbackTarget.getHandlerContext(),
                        callbackTarget.getBrowser(),
                        callbackTarget.isDisposed()
                );

                if (afterSendOnEdt != null) {
                    afterSendOnEdt.run();
                }
            });
        });
    }
}
