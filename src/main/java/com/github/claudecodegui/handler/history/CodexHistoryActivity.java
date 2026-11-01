package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Objects;

/**
 * Shared rules for Codex history rows whose native writer must not be deleted.
 *
 * <p>Legacy and native history lists, and the deletion guard itself, must agree
 * on which threads are protected; otherwise a row looks deletable and the
 * backend refuses it after the frontend already removed it.</p>
 */
public final class CodexHistoryActivity {

    private CodexHistoryActivity() {
    }

    /**
     * Returns the active session id when that session belongs to Codex.
     *
     * @param active the window's active session, possibly null
     * @return the Codex thread id, or null for another provider or no session
     */
    public static String activeCodexSessionId(ClaudeSession active) {
        return active != null && "codex".equals(active.getProvider()) ? active.getSessionId() : null;
    }

    /**
     * Whether another window, or a relation outside the active root, holds the thread's writer.
     *
     * @param threadId persisted Codex thread id
     * @param activeSessionId this window's active Codex thread id, possibly null
     * @param bridge this window's Codex bridge, possibly null
     * @return true when the thread must stay protected from this window's deletion
     */
    public static boolean isOwnedElsewhere(String threadId, String activeSessionId, CodexSDKBridge bridge) {
        return bridge != null && bridge.hasCodexThreadOwner(threadId)
                && (!Objects.equals(threadId, activeSessionId) || !bridge.ownsCodexThread(threadId));
    }

    /**
     * Mark each row's {@code running} flag, and {@code ownedElsewhere} for foreign writers.
     *
     * @param rows history rows; non-object rows and rows without an id are skipped
     * @param idField the row field that carries the thread id
     * @param active the window's active session, possibly null
     * @param bridge this window's Codex bridge, possibly null
     */
    public static void markRows(JsonArray rows, String idField, ClaudeSession active, CodexSDKBridge bridge) {
        String activeId = activeCodexSessionId(active);
        boolean activeBusy = activeId != null
                && (active.isBusy() || active.getState().getExecutionState().hasLiveTurn());
        for (JsonElement element : rows) {
            String threadId = element.isJsonObject() ? stringField(element.getAsJsonObject(), idField) : null;
            if (threadId == null) {
                continue;
            }
            JsonObject row = element.getAsJsonObject();
            boolean ownedElsewhere = isOwnedElsewhere(threadId, activeId, bridge);
            boolean running = activeBusy && threadId.equals(activeId);
            row.addProperty("running", running || ownedElsewhere || isTrue(row.get("running")));
            if (ownedElsewhere) {
                row.addProperty("ownedElsewhere", true);
            }
        }
    }

    private static String stringField(JsonObject row, String field) {
        JsonElement value = row.get(field);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
                ? value.getAsString() : null;
    }

    private static boolean isTrue(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean()
                && value.getAsBoolean();
    }
}
