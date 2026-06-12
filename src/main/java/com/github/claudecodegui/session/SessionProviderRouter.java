package com.github.claudecodegui.session;

import com.github.claudecodegui.common.CommonConstants;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Centralizes provider-specific bridge routing for session operations.
 */
public class SessionProviderRouter {

    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;

    public SessionProviderRouter(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        if (CommonConstants.PROVIDER_CODEX.equals(provider)) {
            return codexSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        return claudeSDKBridge.launchChannel(channelId, sessionId, cwd);
    }

    public void interruptChannel(String provider, String channelId) {
        if (CommonConstants.PROVIDER_CODEX.equals(provider)) {
            codexSDKBridge.interruptChannel(channelId);
            return;
        }
        claudeSDKBridge.interruptChannel(channelId);
    }

    public void cleanupProviderSession(String provider, String sessionId, String cwd) {
        if (CommonConstants.PROVIDER_CODEX.equals(provider)) {
            codexSDKBridge.clearCachedThread(sessionId, cwd);
        }
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        if (CommonConstants.PROVIDER_CODEX.equals(provider)) {
            return codexSDKBridge.getSessionMessages(sessionId, cwd);
        }
        return claudeSDKBridge.getSessionMessages(sessionId, cwd);
    }
}
