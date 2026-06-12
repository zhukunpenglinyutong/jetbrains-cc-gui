package com.github.claudecodegui.ui.toolwindow;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Buffers a code snippet that arrives before the webview frontend is ready.
 *
 * <p>External callers (e.g. the editor "Send selection to CC GUI" action) may push a
 * snippet while the JCEF webview is still loading. The snippet is held here and flushed
 * once the frontend signals readiness.
 *
 * <p>Thread-safe: {@link #offer} and {@link #takePending} use an atomic swap so a
 * deferred snippet is emitted exactly once even when several frontend-ready callbacks
 * fire concurrently. This matters because {@code ClaudeChatWindow} registers
 * {@code setFrontendReady} on two separate delegates, both of which flush this buffer.
 */
final class PendingCodeSnippetBuffer {

    private final AtomicReference<String> pending = new AtomicReference<>();

    /**
     * Records a snippet for display.
     *
     * @param snippet       the snippet to show (callers must pass a non-empty value)
     * @param frontendReady whether the webview frontend is ready to receive it now
     * @return the snippet to emit immediately when {@code frontendReady} is {@code true};
     *         {@code null} when the snippet was deferred until the frontend is ready
     */
    String offer(String snippet, boolean frontendReady) {
        if (frontendReady) {
            return snippet;
        }
        pending.set(snippet);
        return null;
    }

    /**
     * Atomically takes the deferred snippet, clearing the buffer.
     *
     * @return the deferred snippet, or {@code null} if nothing is pending
     */
    String takePending() {
        return pending.getAndSet(null);
    }
}
