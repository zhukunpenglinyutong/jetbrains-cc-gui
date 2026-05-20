package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Provider-specific CLI boundary.
 */
public interface CliAdapter {
    CompletableFuture<SDKResult> send(CliRequest request, MessageCallback callback);

    JsonObject launch(RuntimeKey key, String sessionId, String cwd);

    void interrupt(RuntimeKey key);

    List<JsonObject> loadMessages(String sessionId, String cwd);
}
