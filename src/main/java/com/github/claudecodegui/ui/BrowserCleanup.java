package com.github.claudecodegui.ui;

import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import java.util.function.Consumer;

/** Retains native resources until disposal succeeds, separately from the usable host browser. */
final class BrowserCleanup<T> {
    private static final Logger LOG = Logger.getInstance(BrowserCleanup.class);
    private final Set<T> retained = Collections.newSetFromMap(new IdentityHashMap<>());
    private final Consumer<T> disposer;
    private boolean cleaning;

    BrowserCleanup(Consumer<T> disposer) {
        this.disposer = disposer;
    }

    synchronized void retain(T browser) {
        if (browser != null) {
            retained.add(browser);
        }
    }

    synchronized boolean hasPendingCleanup() {
        return cleaning || !retained.isEmpty();
    }

    boolean dispose(T browser) {
        synchronized (this) {
            retained.add(browser);
            if (cleaning) {
                return false;
            }
            cleaning = true;
        }
        try {
            disposer.accept(browser);
            synchronized (this) {
                retained.remove(browser);
            }
            return true;
        } catch (Exception | LinkageError error) {
            LOG.warn("Browser cleanup failed; resource retained for explicit retry or window disposal", error);
            return false;
        } finally {
            synchronized (this) {
                cleaning = false;
            }
        }
    }

    void retry() {
        ArrayList<T> snapshot;
        synchronized (this) {
            snapshot = new ArrayList<>(retained);
        }
        for (T browser : snapshot) {
            dispose(browser);
        }
    }
}
