package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.provider.ModelProviderHandler;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Grok SDK bridge (Claude-template architecture).
 *
 * Java contract mirrors {@code ClaudeSDKBridge} send shape:
 * session/epoch/cwd/attachments/permissionMode/model/openedFiles/agentPrompt/streaming/reasoning.
 *
 * Node transport is ACP primary ({@code grok agent stdio}) which emits Claude-compatible tags.
 */
public class GrokSDKBridge extends BaseSDKBridge {

    private String baseUrl = null;
    private String apiKey = null;
    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    private final GrokDaemonCoordinator daemonCoordinator;
    private final GrokDaemonRequestExecutor daemonRequestExecutor;

    /** Last observed token total from ACP [USAGE] for /context synthesis. */
    private final AtomicInteger lastUsedTokens = new AtomicInteger(0);
    private volatile String lastUsageModel = "";

    public GrokSDKBridge() {
        super(GrokSDKBridge.class);

        this.daemonCoordinator = new GrokDaemonCoordinator(
                LOG,
                nodeDetector,
                this::getDirectoryResolver,
                envConfigurator,
                env -> configureProviderEnv(env, "{}")
        );
        this.daemonRequestExecutor = new GrokDaemonRequestExecutor(LOG, this);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "grok";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("GROK_USE_STDIN", "true");
        env.put("GROK_NO_AUTO_UPDATE", "1");
        env.put("CI", "1");

        try {
            JsonObject grokEnv = settingsService.getGrokEnv();
            if (grokEnv != null && grokEnv.size() > 0) {
                for (String key : grokEnv.keySet()) {
                    if (grokEnv.get(key) != null && !grokEnv.get(key).isJsonNull()) {
                        env.put(key, grokEnv.get(key).getAsString());
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[Grok] Failed to apply custom grok environment: " + e.getMessage());
        }

        GrokLocalAuthResolver.ResolvedAuth resolved = resolveEffectiveAuth();
        String authMethod = resolved.authMethod;
        env.put("GROK_AUTH_METHOD", authMethod);
        if (resolved.fellBackFromOauth) {
            LOG.info("[Grok] OAuth token missing; falling back to api_key (" + resolved.reason + ")");
        }

        // OAuth mode must not inherit a team API key from the host environment —
        // that forces Grok CLI onto xai.api_key and yields 403 "no credits".
        if (CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(authMethod)) {
            env.remove("XAI_API_KEY");
            env.remove("GROK_API_KEY");
        } else {
            String effectiveKey = resolved.apiKey;
            if (effectiveKey == null || effectiveKey.isEmpty()) {
                effectiveKey = resolveApiKeyForAuth(authMethod);
            }
            if (effectiveKey != null && !effectiveKey.isEmpty()) {
                env.put("XAI_API_KEY", effectiveKey);
                env.put("GROK_API_KEY", effectiveKey);
            } else {
                env.remove("XAI_API_KEY");
                env.remove("GROK_API_KEY");
            }
        }

        String effectiveBase = resolved.baseUrl;
        if (effectiveBase == null || effectiveBase.isEmpty()) {
            effectiveBase = resolveEffectiveBaseUrl(authMethod);
        }
        applyBaseUrlEnv(env, authMethod, effectiveBase);
    }

    /**
     * Apply gateway / direct base URL env vars for the given auth method.
     * Empty base leaves defaults (direct xAI / cli-chat-proxy).
     */
    private void applyBaseUrlEnv(Map<String, String> env, String authMethod, String effectiveBase) {
        if (effectiveBase == null || effectiveBase.isEmpty()) {
            return;
        }
        // Official CLI: GROK_MODELS_BASE_URL drives inference + /models (api_key path).
        // Without it the CLI ignores XAI_API_BASE_URL and never hits local-agent.
        String modelsList = effectiveBase.replaceAll("/+$", "") + "/models";
        env.put("GROK_MODELS_BASE_URL", effectiveBase);
        env.put("GROK_MODELS_LIST_URL", modelsList);
        env.put("GROK_BASE_URL", effectiveBase);

        if (CodemossSettingsService.GROK_AUTH_METHOD_API_KEY.equals(authMethod)) {
            env.put("XAI_API_BASE_URL", effectiveBase);
            // Chat/agent also uses cli-chat-proxy base under hosts-block setups.
            env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
        } else if (CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(authMethod)) {
            env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
            // Avoid forcing API base onto xai path when using SuperGrok OAuth
            env.remove("XAI_API_BASE_URL");
        } else {
            // auto: set both so whichever auth path the CLI picks works
            env.put("XAI_API_BASE_URL", effectiveBase);
            env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
        }
    }

    private String resolveEffectiveBaseUrl(String authMethod) {
        try {
            return settingsService.resolveGrokBaseUrlForAuth(authMethod, this.baseUrl);
        } catch (Exception e) {
            LOG.warn("[Grok] Failed to resolve base URL: " + e.getMessage());
            return this.baseUrl != null ? this.baseUrl : "";
        }
    }

    private String resolveAuthMethod() {
        return resolveEffectiveAuth().authMethod;
    }

    private String resolvePreferredAuthMethod() {
        try {
            return settingsService.getGrokAuthMethod();
        } catch (Exception e) {
            LOG.warn("[Grok] Failed to read grok.authMethod, defaulting to oauth: " + e.getMessage());
            return CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD;
        }
    }

    /**
     * Plugin setting + local ~/.grok state:
     * OAuth without token → config.toml / settings api_key.
     */
    private GrokLocalAuthResolver.ResolvedAuth resolveEffectiveAuth() {
        String preferred = resolvePreferredAuthMethod();
        String explicitKey = "";
        if (apiKey != null && !apiKey.isEmpty()) {
            explicitKey = apiKey;
        } else {
            try {
                String stored = settingsService.getGrokApiKey();
                if (stored != null && !stored.isEmpty()) {
                    explicitKey = stored;
                }
            } catch (Exception e) {
                LOG.debug("[Grok] Failed to read stored grok.apiKey: " + e.getMessage());
            }
        }
        String explicitBase = this.baseUrl != null ? this.baseUrl : "";
        if (explicitBase.isEmpty()) {
            try {
                explicitBase = settingsService.resolveGrokBaseUrlForAuth(preferred, null);
            } catch (Exception e) {
                LOG.debug("[Grok] Failed to resolve base URL for auth: " + e.getMessage());
            }
        }
        return GrokLocalAuthResolver.resolve(preferred, explicitKey, explicitBase);
    }

    private String resolveApiKeyForAuth(String authMethod) {
        // Prefer resolved effective auth (includes config.toml fallback).
        GrokLocalAuthResolver.ResolvedAuth resolved = resolveEffectiveAuth();
        if (authMethod != null
                && authMethod.equals(resolved.authMethod)
                && resolved.apiKey != null
                && !resolved.apiKey.isEmpty()) {
            return resolved.apiKey;
        }
        // Explicit bridge key wins when set by host
        if (apiKey != null && !apiKey.isEmpty()) {
            return apiKey;
        }
        if (CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(authMethod)) {
            return "";
        }
        try {
            String stored = settingsService.getGrokApiKey();
            if (stored != null && !stored.isEmpty()) {
                return stored;
            }
        } catch (Exception e) {
            LOG.debug("[Grok] Failed to read stored grok.apiKey: " + e.getMessage());
        }
        if (CodemossSettingsService.GROK_AUTH_METHOD_API_KEY.equals(authMethod)
                || CodemossSettingsService.GROK_AUTH_METHOD_AUTO.equals(authMethod)) {
            String envKey = System.getenv("XAI_API_KEY");
            if (envKey == null || envKey.isEmpty()) {
                envKey = System.getenv("GROK_API_KEY");
            }
            return envKey != null ? envKey : "";
        }
        return "";
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        if (line.contains("[DEBUG]") || line.startsWith("[GROK-ACP]") || line.startsWith("[DIAG-")) {
            LOG.debug("[Grok] " + line);
            return;
        }

        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[COMMAND_ERROR]")
                || line.startsWith("[UNCAUGHT_ERROR]")
                || line.startsWith("[UNHANDLED_REJECTION]")) {
            lastNodeError.set(line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
            return;
        }
        if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
            return;
        }
        if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
            return;
        }
        if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
            return;
        }
        if (line.startsWith("[BLOCK_RESET]")) {
            callback.onMessage("block_reset", "");
            return;
        }
        if (line.startsWith("[SESSION_ID]")) {
            String id = line.substring("[SESSION_ID]".length()).trim();
            if (!id.isEmpty()) {
                callback.onMessage("session_id", id);
            }
            return;
        }
        if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    result.messages.add(msg);
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "assistant";
                    callback.onMessage(msgType, jsonStr);

                    if ("assistant".equals(msgType)) {
                        String text = extractAssistantText(msg);
                        if (text != null && !text.isEmpty() && assistantContent.indexOf(text) < 0) {
                            // Prefer full message text when longer than deltas
                            if (text.length() >= assistantContent.length()) {
                                assistantContent.setLength(0);
                                assistantContent.append(text);
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            return;
        }
        if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
            return;
        }
        if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            assistantContent.append(content);
            callback.onMessage("content", content);
            return;
        }
        if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
            return;
        }
        if (line.startsWith("[THINKING]")) {
            callback.onMessage("thinking", line.substring("[THINKING]".length()).trim());
            return;
        }
        if (line.startsWith("[TOOL_RESULT]")) {
            callback.onMessage("tool_result", line.substring("[TOOL_RESULT]".length()).trim());
            return;
        }
        if (line.startsWith("[USAGE]")) {
            String usageJson = line.substring("[USAGE]".length()).trim();
            try {
                JsonObject usage = gson.fromJson(usageJson, JsonObject.class);
                // Canonical snake_case for Java consumers; camelCase ACP is fallback input.
                JsonObject canonical = GrokContextUsageBuilder.normalizeUsageToSnakeCase(usage);
                if (canonical != null) {
                    usageJson = gson.toJson(canonical);
                    usage = canonical;
                }
                int used = GrokContextUsageBuilder.extractUsedTokens(usage);
                if (used > 0) {
                    lastUsedTokens.set(used);
                }
            } catch (Exception ignored) {
            }
            callback.onMessage("usage", usageJson);
            return;
        }
        if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj != null && obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
            return;
        }

        // Final JSON result line from Node (success envelope)
        if (line.startsWith("{") && line.contains("\"success\"")) {
            try {
                JsonObject obj = gson.fromJson(line, JsonObject.class);
                if (obj != null && obj.has("success") && !obj.get("success").getAsBoolean()) {
                    String err = obj.has("error") ? obj.get("error").getAsString() : line;
                    hadSendError.set(true);
                    result.success = false;
                    result.error = err;
                    callback.onError(err);
                } else if (obj != null && obj.has("sessionId") && !obj.get("sessionId").isJsonNull()) {
                    String sid = obj.get("sessionId").getAsString();
                    if (sid != null && !sid.isEmpty()) {
                        callback.onMessage("session_id", sid);
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            return jsonStr;
        }
    }

    private String extractAssistantText(JsonObject msg) {
        if (msg == null || !msg.has("message")) {
            return null;
        }
        try {
            JsonObject message = msg.getAsJsonObject("message");
            if (message == null || !message.has("content")) {
                return null;
            }
            com.google.gson.JsonElement contentEl = message.get("content");
            if (contentEl.isJsonArray()) {
                StringBuilder sb = new StringBuilder();
                for (com.google.gson.JsonElement el : contentEl.getAsJsonArray()) {
                    if (el.isJsonObject()) {
                        JsonObject block = el.getAsJsonObject();
                        if (block.has("text")) {
                            sb.append(block.get("text").getAsString());
                        }
                    }
                }
                return sb.toString();
            } else if (contentEl.isJsonPrimitive()) {
                return contentEl.getAsString();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    // ============================================================================
    // Grok-specific configuration
    // ============================================================================

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getBaseUrl() {
        return this.baseUrl;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public String getApiKey() {
        return this.apiKey;
    }

    // ============================================================================
    // Daemon lifecycle (parity with Claude)
    // ============================================================================

    public void addDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.addDaemonEventListener(listener);
    }

    public void removeDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.removeDaemonEventListener(listener);
    }

    public void shutdownDaemon() {
        daemonCoordinator.shutdownDaemon();
    }

    public DaemonBridge getCurrentDaemonBridgeForInspection() {
        return daemonCoordinator.getCurrentDaemonBridge();
    }

    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch) {
        daemonCoordinator.prewarmDaemonAsync(cwd, runtimeSessionEpoch);
    }

    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch, String sessionId) {
        daemonCoordinator.prewarmDaemonAsync(cwd, runtimeSessionEpoch, sessionId);
    }

    public void resetPersistentRuntime(String runtimeSessionEpoch) {
        daemonCoordinator.resetPersistentRuntime(runtimeSessionEpoch);
    }

    /**
     * Push permission mode to the live Grok daemon runtime so Auto/bypass takes
     * effect mid-turn (session/request_permission + always-approve), not only on
     * the next user message.
     *
     * <p>Mirrors {@code ClaudeSDKBridge#setPermissionModeLive}: best-effort against
     * an already-running daemon only (no spawn). A fresh daemon has no runtime, so
     * {@code setPermissionModePersistent} would be a no-op.
     *
     * @return JSON with success/applied/reason (or error) for diagnostics
     */
    public CompletableFuture<JsonObject> setPermissionModeLive(String sessionId, String epoch, String mode) {
        // Non-spawning accessor: only push to an already-running daemon.
        DaemonBridge db = this.daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            JsonObject skipped = new JsonObject();
            skipped.addProperty("success", true);
            skipped.addProperty("applied", false);
            skipped.addProperty("reason", "no-daemon");
            LOG.info("[Grok] setPermissionModeLive skipped (no live daemon): mode=" + mode);
            return CompletableFuture.completedFuture(skipped);
        }

        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (epoch != null && !epoch.isEmpty()) {
            params.addProperty("runtimeSessionEpoch", epoch);
        }
        if (mode != null && !mode.isEmpty()) {
            params.addProperty("permissionMode", mode);
        }

        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        // setPermissionMode only emits {id, done, success} — complete from onComplete/onError.
        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) { }

            @Override
            public void onStderr(String text) { }

            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", error != null ? error : "unknown");
                    resultFuture.complete(err);
                }
            }

            @Override
            public void onComplete(boolean success) {
                if (!resultFuture.isDone()) {
                    JsonObject ok = new JsonObject();
                    ok.addProperty("success", success);
                    // Daemon applied flag is best-effort; success=true means command finished.
                    ok.addProperty("applied", success);
                    resultFuture.complete(ok);
                }
            }
        };

        try {
            LOG.info("[Grok] setPermissionModeLive → grok.setPermissionMode mode=" + mode
                    + " sessionId=" + (sessionId != null ? sessionId : "(none)")
                    + " epoch=" + (epoch != null ? epoch : "(none)"));
            CompletableFuture<Boolean> commandFuture = db.sendCommand("grok.setPermissionMode", params, callback);
            commandFuture.exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", ex.getMessage() != null ? ex.getMessage() : "sendCommand failed");
                    resultFuture.complete(err);
                }
                return false;
            });
        } catch (Exception e) {
            LOG.error("[Grok] setPermissionModeLive failed: " + e.getMessage(), e);
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", e.getMessage() != null ? e.getMessage() : "exception");
            return CompletableFuture.completedFuture(err);
        }

        return resultFuture.orTimeout(10, TimeUnit.SECONDS).exceptionally(ex -> {
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", "setPermissionMode timed out after 10 seconds");
            return err;
        });
    }

    /**
     * Context usage for the /context dialog.
     * Prefer daemon runtime snapshot when available; otherwise synthesize from the
     * last ACP [USAGE] line + static model context limits.
     */
    public CompletableFuture<JsonObject> getContextUsage(String sessionId, String cwd, String model) {
        String effectiveModel = (model != null && !model.isEmpty()) ? model : lastUsageModel;
        int maxTokens = ModelProviderHandler.getModelContextLimit(effectiveModel);
        int usedTokens = lastUsedTokens.get();

        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db != null && db.isAlive()) {
            return fetchContextUsageFromDaemon(db, sessionId, cwd, effectiveModel)
                    .exceptionally(ex -> {
                        LOG.warn("[Grok] daemon getContextUsage failed, using local synthesis: " + ex.getMessage());
                        return GrokContextUsageBuilder.build(usedTokens, maxTokens, effectiveModel);
                    });
        }

        return CompletableFuture.completedFuture(
                GrokContextUsageBuilder.build(usedTokens, maxTokens, effectiveModel)
        );
    }

    private CompletableFuture<JsonObject> fetchContextUsageFromDaemon(
            DaemonBridge db, String sessionId, String cwd, String model) {
        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (cwd != null && !cwd.isEmpty()) {
            params.addProperty("cwd", cwd);
        }
        if (model != null && !model.isEmpty()) {
            params.addProperty("model", model);
        }
        params.addProperty("usedTokens", lastUsedTokens.get());
        params.addProperty("maxTokens", ModelProviderHandler.getModelContextLimit(model));

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                try {
                    JsonObject parsed = gson.fromJson(line, JsonObject.class);
                    if (parsed != null) {
                        resultRef.set(parsed);
                    }
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onStderr(String text) { }

            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    resultFuture.completeExceptionally(
                            new RuntimeException(error != null ? error : "getContextUsage error"));
                }
            }

            @Override
            public void onComplete(boolean success) {
                if (resultFuture.isDone()) {
                    return;
                }
                JsonObject result = resultRef.get();
                if (success && result != null && (!result.has("success") || result.get("success").getAsBoolean())) {
                    resultFuture.complete(result);
                } else if (result != null && result.has("success") && !result.get("success").getAsBoolean()) {
                    // Fall through to local synthesis via exceptionally path
                    resultFuture.completeExceptionally(new RuntimeException(
                            result.has("error") ? result.get("error").getAsString() : "daemon context usage failed"));
                } else {
                    resultFuture.completeExceptionally(new RuntimeException("No context usage response"));
                }
            }
        };

        try {
            db.sendCommand("grok.getContextUsage", params, callback).exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    resultFuture.completeExceptionally(ex);
                }
                return false;
            });
        } catch (Exception e) {
            resultFuture.completeExceptionally(e);
        }

        return resultFuture.orTimeout(15, TimeUnit.SECONDS);
    }

    /**
     * Live Grok billing/credits snapshot for the Usage Statistics panel.
     * Tries the daemon (which may shell out to the Grok CLI); on failure returns
     * a structured {@code data.unavailable} payload so the UI can stop loading.
     */
    public CompletableFuture<JsonObject> getUsage(String cwd) {
        // Non-spawning: Settings panel must not start a cold daemon just to refresh billing.
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            return CompletableFuture.completedFuture(buildUsageUnavailable(
                    "Grok daemon is not running. Open a Grok chat turn first, or check Node/daemon setup."));
        }

        JsonObject params = new JsonObject();
        if (cwd != null && !cwd.isEmpty()) {
            params.addProperty("cwd", cwd);
        }
        GrokLocalAuthResolver.ResolvedAuth resolvedUsage = resolveEffectiveAuth();
        String authMethod = resolvedUsage.authMethod;
        params.addProperty("authMethod", authMethod != null ? authMethod : "");
        String effectiveKey = resolvedUsage.apiKey;
        if (effectiveKey == null || effectiveKey.isEmpty()) {
            effectiveKey = resolveApiKeyForAuth(authMethod);
        }
        params.addProperty("apiKey", effectiveKey != null ? effectiveKey : "");
        String effectiveBase = resolvedUsage.baseUrl;
        if (effectiveBase == null || effectiveBase.isEmpty()) {
            effectiveBase = resolveEffectiveBaseUrl(authMethod);
        }
        params.addProperty("baseUrl", effectiveBase != null ? effectiveBase : "");

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                try {
                    JsonObject parsed = gson.fromJson(line, JsonObject.class);
                    if (parsed != null) {
                        resultRef.set(parsed);
                    }
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onStderr(String text) { }

            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    resultFuture.complete(buildUsageUnavailable(
                            error != null ? error : "getUsage failed"));
                }
            }

            @Override
            public void onComplete(boolean success) {
                if (resultFuture.isDone()) {
                    return;
                }
                JsonObject result = resultRef.get();
                if (result != null) {
                    resultFuture.complete(result);
                } else {
                    resultFuture.complete(buildUsageUnavailable(
                            success ? "No usage payload from Grok daemon" : "getUsage command failed"));
                }
            }
        };

        try {
            db.sendCommand("grok.getUsage", params, callback).exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    resultFuture.complete(buildUsageUnavailable(
                            ex.getMessage() != null ? ex.getMessage() : "sendCommand failed"));
                }
                return false;
            });
        } catch (Exception e) {
            return CompletableFuture.completedFuture(buildUsageUnavailable(e.getMessage()));
        }

        return resultFuture.orTimeout(45, TimeUnit.SECONDS).exceptionally(ex ->
                buildUsageUnavailable("getUsage timed out: " + (ex.getMessage() != null ? ex.getMessage() : "timeout"))
        );
    }

    /** Payload shape that {@code useUsageStatistics} accepts without hanging the spinner. */
    static JsonObject buildUsageUnavailable(String message) {
        JsonObject root = new JsonObject();
        root.addProperty("success", true);
        JsonObject data = new JsonObject();
        data.addProperty("unavailable", true);
        data.addProperty("message", message != null ? message : "Grok billing is unavailable");
        data.addProperty("source", "plugin-fallback");
        root.add("data", data);
        return root;
    }

    /** Package-visible for tests: last captured ACP usage total. */
    int getLastUsedTokensForTest() {
        return lastUsedTokens.get();
    }

    void setLastUsedTokensForTest(int tokens) {
        lastUsedTokens.set(tokens);
    }

    /**
     * Dynamically loads Grok models that support reasoning effort (Low/Medium/High/XHigh)
     * by reading ~/.grok/models_cache.json .
     * Returns { success: true, supportedModels: ["grok-build", ...] }
     */
    public JsonObject getReasoningSupportedModels() {
        JsonObject result = new JsonObject();
        JsonArray supported = new JsonArray();
        try {
            Path cachePath = Paths.get(PlatformUtils.getHomeDirectory(), ".grok", "models_cache.json");
            if (!Files.exists(cachePath)) {
                result.addProperty("success", true);
                result.add("supportedModels", supported);
                return result;
            }
            String content = Files.readString(cachePath);
            JsonObject data = gson.fromJson(content, JsonObject.class);
            JsonObject models = null;
            if (data != null) {
                if (data.has("models") && data.get("models").isJsonObject()) {
                    models = data.getAsJsonObject("models");
                } else {
                    // sometimes the top level may be the models map in older caches
                    models = data;
                }
            }
            if (models != null) {
                for (Map.Entry<String, com.google.gson.JsonElement> entry : models.entrySet()) {
                    String id = entry.getKey();
                    com.google.gson.JsonElement val = entry.getValue();
                    com.google.gson.JsonObject info = null;
                    if (val != null && val.isJsonObject()) {
                        com.google.gson.JsonObject obj = val.getAsJsonObject();
                        if (obj.has("info") && obj.get("info").isJsonObject()) {
                            info = obj.getAsJsonObject("info");
                        } else {
                            info = obj;
                        }
                    }
                    if (info != null && info.has("supports_reasoning_effort")
                            && info.get("supports_reasoning_effort").getAsBoolean()) {
                        supported.add(id);
                    }
                }
            }
            result.addProperty("success", true);
            result.add("supportedModels", supported);
        } catch (Exception e) {
            LOG.warn("[GrokSDKBridge] Failed to load reasoning supports from cache: " + e.getMessage());
            result.addProperty("success", false);
            result.addProperty("error", e.getMessage());
            result.add("supportedModels", supported);
        }
        return result;
    }

    /**
     * Interrupt a channel. In daemon mode, sends an abort command to cancel the
     * active Grok ACP turn. Also delegates to ProcessManager for fallback.
     */
    @Override
    public void interruptChannel(String channelId) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db != null && db.isAlive()) {
            LOG.info("[GrokSDKBridge] Sending daemon abort for channel: " + channelId);
            try {
                db.sendAbort();
            } catch (Exception e) {
                LOG.error("[GrokSDKBridge] Daemon abort failed: " + e.getMessage());
            }
        }
        // Also try per-process interrupt (covers one-shot fallback)
        super.interruptChannel(channelId);
    }

    @Override
    public void cleanupAllProcesses() {
        shutdownDaemon();
        super.cleanupAllProcesses();
    }

    // ============================================================================
    // Message sending (Claude-shaped)
    // ============================================================================

    /**
     * Full Claude-shaped send entry (preferred). Tries daemon first for persistent ACP.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        String normalizedCwd = normalizeCwdForNode(cwd);

        DaemonBridge db = daemonCoordinator.getDaemonBridge();
        if (db != null) {
            return sendMessageViaDaemon(db, channelId, message, sessionId, runtimeSessionEpoch,
                    normalizedCwd, attachments, permissionMode, model, openedFiles,
                    agentPrompt, streaming, disableThinking, reasoningEffort, callback);
        }

        LOG.info("[GrokSDKBridge] Using per-process (channel-manager) mode (daemon unavailable)");
        // Fallback to one-shot
        JsonObject stdinInput = buildStdinPayloadForDaemon(
                message, sessionId, runtimeSessionEpoch, normalizedCwd, attachments,
                permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort
        );
        String stdinJson = gson.toJson(stdinInput);
        List<String> command = buildBaseCommand("send");
        LOG.info("[Grok] sendMessage (fallback) sessionId=" + (sessionId != null ? sessionId : "(new)")
                + ", epoch=" + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)")
                + ", model=" + (model != null ? model : "(default)"));

        return executeStreamingCommand(channelId, command, stdinJson, normalizedCwd, callback);
    }

    private String normalizeCwdForNode(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return cwd;
        }
        String nodePath = nodeDetector.getCachedNodePath();
        boolean isWsl = nodePath != null && NodeDetector.isWslPath(nodePath);
        return isWsl ? NodeDetector.convertToWslPath(cwd) : cwd;
    }

    private CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return daemonRequestExecutor.sendMessageViaDaemon(
                daemon, channelId, message, sessionId, runtimeSessionEpoch, cwd,
                attachments, permissionMode, model, openedFiles, agentPrompt,
                streaming, disableThinking, reasoningEffort, callback
        );
    }

    /**
     * Compatibility overload used by older call sites.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            MessageCallback callback
    ) {
        return sendMessage(
                channelId,
                message,
                sessionId,
                null,
                cwd,
                attachments,
                permissionMode,
                model,
                null,
                agentPrompt,
                true,
                false,
                null,
                callback
        );
    }

    // Package-visible for GrokDaemonRequestExecutor
    JsonObject buildStdinPayloadForDaemon(
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort
    ) {
        return buildStdinPayload(
                message, sessionId, runtimeSessionEpoch, cwd, attachments,
                permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort
        );
    }

    private JsonObject buildStdinPayload(
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort
    ) {
        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("message", message != null ? message : "");
        stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
        if (runtimeSessionEpoch != null && !runtimeSessionEpoch.isEmpty()) {
            stdinInput.addProperty("runtimeSessionEpoch", runtimeSessionEpoch);
        }
        stdinInput.addProperty("cwd", cwd != null ? cwd : "");
        stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        stdinInput.addProperty("model", model != null ? model : "");
        GrokLocalAuthResolver.ResolvedAuth resolved = resolveEffectiveAuth();
        String authMethod = resolved.authMethod;
        String effectiveBase = resolved.baseUrl;
        if (effectiveBase == null || effectiveBase.isEmpty()) {
            effectiveBase = resolveEffectiveBaseUrl(authMethod);
        }
        stdinInput.addProperty("baseUrl", effectiveBase != null ? effectiveBase : "");
        stdinInput.addProperty("authMethod", authMethod);
        String effectiveKey = resolved.apiKey;
        if (effectiveKey == null || effectiveKey.isEmpty()) {
            effectiveKey = resolveApiKeyForAuth(authMethod);
        }
        stdinInput.addProperty("apiKey", effectiveKey != null ? effectiveKey : "");
        stdinInput.addProperty("agentPrompt", agentPrompt != null ? agentPrompt : "");
        stdinInput.addProperty("streaming", streaming == null || streaming);
        stdinInput.addProperty("disableThinking", disableThinking);
        if (reasoningEffort != null && !reasoningEffort.isEmpty()) {
            stdinInput.addProperty("reasoningEffort", reasoningEffort);
        }
        if (openedFiles != null) {
            stdinInput.add("openedFiles", openedFiles);
        }
        if (attachments != null && !attachments.isEmpty()) {
            JsonArray attArr = new JsonArray();
            for (ClaudeSession.Attachment a : attachments) {
                JsonObject o = new JsonObject();
                o.addProperty("fileName", a.fileName);
                o.addProperty("mediaType", a.mediaType);
                o.addProperty("data", a.data);
                attArr.add(o);
            }
            stdinInput.add("attachments", attArr);
        }
        return stdinInput;
    }

    /**
     * Session messages from Grok CLI on-disk history
     * ({@code $GROK_HOME/sessions}, default {@code ~/.grok/sessions}).
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new GrokHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[GrokSDKBridge] Failed to load session messages: " + e.getMessage());
            return java.util.Collections.emptyList();
        }
    }
}
