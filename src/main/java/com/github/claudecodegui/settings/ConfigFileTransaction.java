package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.SafeJsonFileOps;

import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicReference;

/** Shared lock order for config.json read-modify-write operations: state, then file. */
final class ConfigFileTransaction {
    static final Object STATE_LOCK = new Object();

    private ConfigFileTransaction() {}

    @FunctionalInterface
    interface Operation<T> {
        T run() throws IOException;
    }

    static <T> T call(Path path, Operation<T> operation) throws IOException {
        synchronized (STATE_LOCK) {
            AtomicReference<T> result = new AtomicReference<>();
            SafeJsonFileOps.withLock(SafeJsonFileOps.sibling(path, ".lock"), 5000,
                    () -> result.set(operation.run()));
            return result.get();
        }
    }

    static void run(Path path, SafeJsonFileOps.IORunnable operation) throws IOException {
        call(path, () -> {
            operation.run();
            return null;
        });
    }

    static boolean isActive() {
        return Thread.holdsLock(STATE_LOCK);
    }
}
