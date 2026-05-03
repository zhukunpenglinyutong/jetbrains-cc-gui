package com.github.claudecodegui.settings;

import com.github.claudecodegui.session.ClaudeSession;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Persists the selected Codex reasoning effort outside the webview lifecycle.
 */
public final class ReasoningEffortStateService {

    private static final Logger LOG = Logger.getInstance(ReasoningEffortStateService.class);

    public static final String DEFAULT_REASONING_EFFORT = "medium";
    private static final String REASONING_EFFORT_KEY = "claude.code.reasoning.effort";

    private ReasoningEffortStateService() {
    }

    public static String normalize(String effort) {
        if (effort == null) {
            return DEFAULT_REASONING_EFFORT;
        }
        String normalized = effort.trim().toLowerCase();
        if ("low".equals(normalized)
                || "medium".equals(normalized)
                || "high".equals(normalized)
                || "xhigh".equals(normalized)) {
            return normalized;
        }
        return DEFAULT_REASONING_EFFORT;
    }

    public static String load() {
        try {
            String saved = PropertiesComponent.getInstance().getValue(REASONING_EFFORT_KEY);
            return normalize(saved);
        } catch (Exception e) {
            LOG.warn("[ReasoningEffort] Failed to load persisted reasoning effort: " + e.getMessage());
            return DEFAULT_REASONING_EFFORT;
        }
    }

    public static void save(String effort) {
        String normalized = normalize(effort);
        try {
            PropertiesComponent.getInstance().setValue(REASONING_EFFORT_KEY, normalized);
            LOG.info("[ReasoningEffort] Saved reasoning effort: " + normalized);
        } catch (Exception e) {
            LOG.warn("[ReasoningEffort] Failed to save reasoning effort: " + e.getMessage());
        }
    }

    public static void applyToSession(ClaudeSession session) {
        if (session == null) {
            return;
        }
        session.setReasoningEffort(load());
    }
}
