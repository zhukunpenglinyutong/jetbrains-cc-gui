package com.github.claudecodegui.ui.toolwindow;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Buffers structured file references until the webview frontend is ready.
 *
 * <p>The list is copied on both sides of the buffer so an external action
 * cannot mutate the payload while a tab is waiting for initialization.
 */
final class PendingFileReferencesBuffer {

    private final AtomicReference<List<String>> pending = new AtomicReference<>();

    /**
     * Return the paths immediately when the frontend is ready, otherwise defer
     * the latest batch until the ready transition flushes it.
     */
    List<String> offer(List<String> filePaths, boolean frontendReady) {
        List<String> snapshot = Collections.unmodifiableList(new ArrayList<>(filePaths));
        if (frontendReady) {
            return snapshot;
        }
        pending.updateAndGet(existing -> {
            if (existing == null) {
                return snapshot;
            }
            List<String> combined = new ArrayList<>(existing.size() + snapshot.size());
            combined.addAll(existing);
            combined.addAll(snapshot);
            return Collections.unmodifiableList(combined);
        });
        return null;
    }

    /** Atomically take the deferred batch, returning it only once. */
    List<String> takePending() {
        return pending.getAndSet(null);
    }
}
