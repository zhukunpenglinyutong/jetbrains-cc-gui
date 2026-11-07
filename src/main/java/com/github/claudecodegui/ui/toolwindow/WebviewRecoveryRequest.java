package com.github.claudecodegui.ui.toolwindow;

/** Binds a client checkpoint acknowledgement to one browser page and a bounded native action. */
final class WebviewRecoveryRequest {
    static final long TIMEOUT_MS = 5000L;
    private Request pending;

    private record Request(String id, Object browser, int generation, long deadline) {
    }

    synchronized boolean begin(String id, Object browser, int generation, long now) {
        if (pending != null && now < pending.deadline()) {
            return false;
        }
        pending = new Request(id, browser, generation, now + TIMEOUT_MS);
        return true;
    }

    // Duplicate or stale acknowledgements cannot recreate a newer browser or another tab.
    synchronized boolean accept(String id, Object browser, int generation, long now) {
        if (pending == null || !pending.id().equals(id)) {
            return false;
        }
        Request request = pending;
        pending = null;
        return request.browser() == browser && request.generation() == generation && now < request.deadline();
    }

    synchronized boolean expire(String id, long now) {
        if (pending == null || !pending.id().equals(id) || now < pending.deadline()) {
            return false;
        }
        pending = null;
        return true;
    }

    synchronized boolean isPending() {
        return pending != null;
    }

    synchronized void cancel() {
        pending = null;
    }
}
