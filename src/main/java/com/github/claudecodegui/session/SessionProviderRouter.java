package com.github.claudecodegui.session;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.opencode.OpenCodeSDKBridge;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Centralizes provider-specific bridge routing for session operations.
 */
public class SessionProviderRouter {

    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final OpenCodeSDKBridge openCodeSDKBridge;

    public SessionProviderRouter(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this(claudeSDKBridge, codexSDKBridge, null);
    }

    public SessionProviderRouter(
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            OpenCodeSDKBridge openCodeSDKBridge
    ) {
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.openCodeSDKBridge = openCodeSDKBridge;
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        switch (normalizeProvider(provider)) {
            case "claude":
                return claudeSDKBridge.launchChannel(channelId, sessionId, cwd);
            case "codex":
                return codexSDKBridge.launchChannel(channelId, sessionId, cwd);
            case "opencode":
                requireOpenCodeBridge();
                requireOpenCodeAuthorized();
                return openCodeSDKBridge.launchChannel(channelId, sessionId, cwd);
            default:
                throw new IllegalArgumentException("Unsupported provider: " + provider);
        }
    }

    public void interruptChannel(String provider, String channelId) {
        switch (normalizeProvider(provider)) {
            case "claude":
                claudeSDKBridge.interruptChannel(channelId);
                return;
            case "codex":
                codexSDKBridge.interruptChannel(channelId);
                return;
            case "opencode":
                requireOpenCodeBridge();
                openCodeSDKBridge.interruptChannel(channelId);
                return;
            default:
                throw new IllegalArgumentException("Unsupported provider: " + provider);
        }
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        switch (normalizeProvider(provider)) {
            case "claude":
                return claudeSDKBridge.getSessionMessages(sessionId, cwd);
            case "codex":
                return codexSDKBridge.getSessionMessages(sessionId, cwd);
            case "opencode":
                requireOpenCodeBridge();
                requireOpenCodeAuthorized();
                return openCodeSDKBridge.getSessionMessages(sessionId, cwd);
            default:
                throw new IllegalArgumentException("Unsupported provider: " + provider);
        }
    }

    private String normalizeProvider(String provider) {
        return provider == null || provider.trim().isEmpty() ? "claude" : provider.trim().toLowerCase();
    }

    private void requireOpenCodeBridge() {
        if (openCodeSDKBridge == null) {
            throw new IllegalStateException("opencode bridge is not configured");
        }
    }

    private void requireOpenCodeAuthorized() {
        try {
            if (new CodemossSettingsService().isOpenCodeLocalConfigAuthorized()) {
                return;
            }
        } catch (Exception e) {
            throw new IllegalStateException("Failed to read opencode authorization state", e);
        }
        throw new IllegalStateException(ClaudeCodeGuiBundle.message("error.openCodeLocalAccessNotAuthorized"));
    }
}
