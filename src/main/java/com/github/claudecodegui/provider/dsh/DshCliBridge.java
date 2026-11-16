package com.github.claudecodegui.provider.dsh;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;

import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * DeepSeek Harness (DSH) bridge.
 *
 * <p>DSH is not a per-turn CLI: the Node channel talks Host RPC + WebSocket
 * mux to one persistent local {@code dsh web} (adopted or auto-spawned by the
 * Node supervisor). From the Java side it still speaks the shared marker
 * protocol, so streaming, tools, usage, and session id all ride the existing
 * Codex-style message handler.
 *
 * <p>Connection settings ({@code DSH_BIN} / {@code DSH_HOST} / {@code DSH_PORT}
 * / {@code DSH_AUTO_START}) come from the plugin config's {@code dsh} section;
 * provider keys and the model catalog stay in the DSH Web UI.
 */
public class DshCliBridge extends MarkerCliBridge {

    /** Upper bound for the host cancel round trip before the send process is killed. */
    static final long HOST_CANCEL_TIMEOUT_MS = 2500L;

    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    /** The turn running on each channel; Stop needs its DSH session id to cancel it on the host. */
    private final Map<String, Turn> turns = new ConcurrentHashMap<>();

    public DshCliBridge() {
        super(DshCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "dsh";
    }

    @Override
    protected String getStdinEnvKey() {
        return "DSH_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        DshEnvSupport.inject(env, settingsService);
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new DshHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[DSH] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd, BooleanSupplier cancellation) {
        return new DshHistoryReader().getSessionMessages(sessionId, cwd, cancellation);
    }

    @Override
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            String model,
            String reasoningEffort,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String dshPreset,
            String ompApprovalMode,
            Boolean thinking,
            MessageCallback callback
    ) {
        Turn turn = startTurn(channelId, sessionId, callback);
        return super.sendMessage(channelId, message, sessionId, cwd, model, reasoningEffort,
                attachments, permissionMode, dshPreset, ompApprovalMode, thinking, turn)
                .whenComplete((result, error) -> forgetTurn(channelId, turn))
                .thenApply(turn::settle);
    }

    Turn startTurn(String channelId, String sessionId, MessageCallback callback) {
        Turn turn = new Turn(sessionId, callback);
        if (channelId != null) {
            turns.put(channelId, turn);
        }
        return turn;
    }

    /** Only drops this turn: a newer send on the same channel may already be registered. */
    void forgetTurn(String channelId, Turn turn) {
        if (channelId != null) {
            turns.remove(channelId, turn);
        }
    }

    /**
     * Ask the DSH host to cancel the running turn before the send process is killed.
     * A force-killed Windows process cannot send the cancel itself, and the host
     * would otherwise keep running the turn.
     */
    @Override
    public void interruptChannel(String channelId) {
        Turn turn = channelId != null ? turns.get(channelId) : null;
        if (turn != null) {
            turn.stopping = true;
            String sessionId = turn.sessionId;
            if (sessionId != null) {
                requestHostCancel(sessionId);
            }
        }
        super.interruptChannel(channelId);
    }

    /**
     * One send on one channel. Remembers the DSH session id for Stop, and once Stop
     * is pressed treats the host's "cancelled" turn end as the stop working, not as an
     * error: the send process can report it and exit before it is killed.
     */
    static final class Turn implements MessageCallback {
        private final MessageCallback delegate;
        private volatile String sessionId;
        private volatile boolean stopping;
        private volatile boolean finished;

        Turn(String sessionId, MessageCallback delegate) {
            this.delegate = delegate;
            track(sessionId);
        }

        private void track(String id) {
            if (id != null && !id.isBlank()) {
                sessionId = id.trim();
            }
        }

        @Override
        public String executionScope() {
            return delegate.executionScope();
        }

        @Override
        public void onMessage(String type, String content) {
            if ("session_id".equals(type)) {
                track(content);
            }
            delegate.onMessage(type, content);
        }

        @Override
        public void onError(String error) {
            if (stopping) {
                return;
            }
            finished = true;
            delegate.onError(error);
        }

        @Override
        public void onComplete(SDKResult result) {
            finished = true;
            delegate.onComplete(result);
        }

        /** Ends a stopped turn whose process exited before reporting the interrupt itself. */
        SDKResult settle(SDKResult result) {
            if (!stopping || finished) {
                return result;
            }
            SDKResult stopped = new SDKResult();
            stopped.success = false;
            stopped.cancelled = true;
            stopped.processExited = result != null && result.processExited;
            stopped.error = "User interrupted";
            onComplete(stopped);
            return stopped;
        }
    }

    /** Best effort: run {@code dsh cancel} and wait a bounded time; never throws. */
    void requestHostCancel(String sessionId) {
        Process process = null;
        try {
            List<String> command = buildBaseCommand("cancel");
            if (command.isEmpty()) {
                return;
            }
            File bridgeDir = getDirectoryResolver().findSdkDir();
            ProcessBuilder pb = new ProcessBuilder(command);
            if (bridgeDir != null) {
                pb.directory(bridgeDir);
            }
            pb.redirectErrorStream(true);
            DshEnvSupport.inject(pb.environment(), settingsService);
            pb.environment().put(getStdinEnvKey(), "true");
            envConfigurator.updateProcessEnvironment(pb, nodeDetector.findNodeExecutable());

            process = pb.start();
            JsonObject stdin = new JsonObject();
            stdin.addProperty("sessionId", sessionId);
            try (OutputStream out = process.getOutputStream()) {
                out.write((gson.toJson(stdin) + "\n").getBytes(StandardCharsets.UTF_8));
            }
            if (!process.waitFor(HOST_CANCEL_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                LOG.warn("[DSH] Host cancel timed out for session " + sessionId);
                return;
            }
            // The output is a few log lines and one JSON result, far below the pipe buffer.
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).strip();
            if (!output.contains("\"success\":true")) {
                LOG.warn("[DSH] Host cancel failed for session " + sessionId + ": "
                        + output.substring(output.lastIndexOf('\n') + 1));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            LOG.warn("[DSH] Host cancel failed for session " + sessionId + ": " + e.getMessage());
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }
}
