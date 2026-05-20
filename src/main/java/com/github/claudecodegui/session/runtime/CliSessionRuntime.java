package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tab-owned one-shot CLI runtime boundary.
 */
public class CliSessionRuntime {
    private static final Logger LOG = Logger.getInstance(CliSessionRuntime.class);

    private final Map<String, CliAdapter> adapters;
    private final Map<RuntimeKey, RuntimeState> states = new ConcurrentHashMap<>();

    public CliSessionRuntime(Map<String, CliAdapter> adapters) {
        this.adapters = Map.copyOf(adapters);
    }

    public CompletableFuture<SDKResult> send(CliRequest request, MessageCallback callback) {
        CliAdapter adapter = adapterFor(request.key().provider());
        states.put(request.key(), new RuntimeState(
                request.sessionIdOrThreadId(),
                request.cwd(),
                request.model(),
                request.permissionMode(),
                request.key().runtimeSessionEpoch()
        ));
        MessageCallback scopedCallback = new EpochFilteringCallback(request.key(), callback);
        return adapter.send(request, scopedCallback).whenComplete((result, error) -> states.remove(request.key()));
    }

    public JsonObject launch(RuntimeKey key, String sessionId, String cwd) {
        return adapterFor(key.provider()).launch(key, sessionId, cwd);
    }

    public void interrupt(RuntimeKey key) {
        adapterFor(key.provider()).interrupt(key);
    }

    public List<JsonObject> loadMessages(String provider, String sessionId, String cwd) {
        return adapterFor(provider).loadMessages(sessionId, cwd);
    }

    public void cleanup(RuntimeKey key) {
        states.remove(key);
        adapterFor(key.provider()).interrupt(key);
    }

    private CliAdapter adapterFor(String provider) {
        CliAdapter adapter = adapters.get(provider);
        if (adapter == null) {
            throw new IllegalArgumentException("Unsupported CLI provider: " + provider);
        }
        return adapter;
    }

    private boolean isCurrentEpoch(RuntimeKey key) {
        RuntimeState state = states.get(key);
        return state == null || key.runtimeSessionEpoch().equals(state.runtimeSessionEpoch);
    }

    private record RuntimeState(
            String sessionIdOrThreadId,
            String cwd,
            String model,
            String permissionMode,
            String runtimeSessionEpoch
    ) {
    }

    private class EpochFilteringCallback implements MessageCallback {
        private final RuntimeKey key;
        private final MessageCallback delegate;

        EpochFilteringCallback(RuntimeKey key, MessageCallback delegate) {
            this.key = key;
            this.delegate = delegate;
        }

        @Override
        public void onMessage(String type, String content) {
            if (!isCurrentEpoch(key)) {
                LOG.debug("Dropping stale CLI message for runtime: " + key);
                return;
            }
            delegate.onMessage(type, content);
        }

        @Override
        public void onError(String error) {
            if (!isCurrentEpoch(key)) {
                LOG.debug("Dropping stale CLI error for runtime: " + key);
                return;
            }
            delegate.onError(error);
        }

        @Override
        public void onComplete(SDKResult result) {
            if (!isCurrentEpoch(key)) {
                LOG.debug("Dropping stale CLI completion for runtime: " + key);
                return;
            }
            delegate.onComplete(result);
        }

        @Override
        public void onQueueDisplayStateChanged(com.github.claudecodegui.session.ClaudeSession.SessionCallback.QueueDisplayState state, int aheadCount) {
            if (!isCurrentEpoch(key)) {
                return;
            }
            delegate.onQueueDisplayStateChanged(state, aheadCount);
        }
    }
}
