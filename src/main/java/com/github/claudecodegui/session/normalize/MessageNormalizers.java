package com.github.claudecodegui.session.normalize;

import com.github.claudecodegui.provider.common.MessageCallback;

public final class MessageNormalizers {
    private MessageNormalizers() {
    }

    public static MessageCallback forRuntime(String provider, String runtime, MessageCallback delegate) {
        String normalizedProvider = provider != null ? provider.trim().toLowerCase() : "";
        String normalizedRuntime = runtime != null ? runtime.trim().toLowerCase() : "";

        if ("codex".equals(normalizedProvider)) {
            return "cli".equals(normalizedRuntime)
                    ? new CodexCliMessageNormalizer(delegate)
                    : new CodexSdkMessageNormalizer(delegate);
        }

        return "cli".equals(normalizedRuntime)
                ? new ClaudeCliMessageNormalizer(delegate)
                : new ClaudeSdkMessageNormalizer(delegate);
    }
}
