package com.github.claudecodegui.session;

import java.util.function.Supplier;

/** File IPC may dispatch on a watcher thread; its opaque turn correlation scopes future creation only. */
public final class SessionInteractionScope {
    private static final ThreadLocal<FileOwner> FILE_OWNER = new ThreadLocal<>();

    private SessionInteractionScope() { }

    private record FileOwner(SessionExecutionOwnership owner) { }

    public static <T> T forFileRequest(String correlation, SessionExecutionOwnership current, Supplier<T> createFuture) {
        FileOwner previous = FILE_OWNER.get();
        SessionExecutionOwnership owner = matches(correlation, current) ? current : null;
        if (owner == null && current != null && (correlation == null || correlation.isEmpty())) {
            // Old bridge requests can still use the existing dialog, but cannot prove which execution is blocked.
            current.state().activity(current.turn(), SessionExecutionState.Phase.UNKNOWN);
        }
        FILE_OWNER.set(new FileOwner(owner));
        try {
            return createFuture.get();
        } finally {
            if (previous == null) {
                FILE_OWNER.remove();
            } else {
                FILE_OWNER.set(previous);
            }
        }
    }

    public static SessionExecutionOwnership resolve(SessionExecutionOwnership current) {
        FileOwner scoped = FILE_OWNER.get();
        return scoped == null ? current : scoped.owner();
    }

    public static boolean matches(String correlation, SessionExecutionOwnership current) {
        return current != null && (current.turn().bindingEpoch() + "/" + current.turn().turnId()).equals(correlation);
    }
}
