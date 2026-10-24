package com.github.claudecodegui.storage;

import com.github.claudecodegui.session.SessionState;

import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/** Observes actual backend sessions across tabs without retaining an IDE project. */
public final class CodexStorageActivity {
    private static final Map<SessionState, Boolean> SESSIONS = Collections.synchronizedMap(new WeakHashMap<>());

    private CodexStorageActivity() { }

    public static void register(SessionState state) {
        SESSIONS.put(state, Boolean.TRUE);
    }

    public static Set<String> runningSessionIds() {
        Set<String> result = new HashSet<>();
        synchronized (SESSIONS) {
            for (SessionState state : SESSIONS.keySet()) {
                if ("codex".equals(state.getProvider()) && state.getSessionId() != null
                        && (state.isBusy() || state.getExecutionState().hasOwnedPendingWork())) {
                    result.add(state.getSessionId());
                }
            }
        }
        return result;
    }

    /** Includes a newly started turn before Codex has assigned its thread ID. */
    public static boolean hasRunningSessions() {
        synchronized (SESSIONS) {
            return SESSIONS.keySet().stream().anyMatch(state -> "codex".equals(state.getProvider())
                    && (state.isBusy() || state.getExecutionState().hasOwnedPendingWork()));
        }
    }
}
