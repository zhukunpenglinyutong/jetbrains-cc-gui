package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.handler.provider.ModelProviderHandler;
import com.github.claudecodegui.provider.common.HistoryCancellation;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/**
 * Reads the Grok CLI files kept next to {@code chat_history.jsonl}: {@code usage.json}
 * (session token totals and model), {@code signals.json} (current context occupancy and
 * window) and {@code updates.jsonl} (per-step usage, used only when signals are missing).
 *
 * <p>Only the session-level context snapshot is restored. Per-turn duration and token
 * stamps would not reach the webview: the transport whitelist drops {@code durationMs}
 * and the turn footer only renders when the frontend measured the duration itself.</p>
 */
final class GrokSessionCompanionFiles {

    private static final Logger LOG = Logger.getInstance(GrokSessionCompanionFiles.class);

    private static final String KEY_USAGE = "usage";
    private static final String KEY_MESSAGE = "message";
    private static final String KEY_TOTAL_TOKENS = "total_tokens";
    private static final String KEY_TOTAL_TOKENS_CAMEL = "totalTokens";

    private GrokSessionCompanionFiles() {
    }

    /** Session token totals in the Claude schema: {@code inputTokens} excludes cache reads and writes. */
    static final class SessionUsageTotals {
        String model;
        long inputTokens;
        long outputTokens;
        long cacheReadTokens;
        long cacheWriteTokens;
        long totalTokens;
    }

    /**
     * Reads {@code usage.json}; session totals win, otherwise the per-turn usage is summed.
     *
     * @param sessionDir Grok session directory, or null
     * @return totals with the session model, or null when the file is missing or unreadable
     */
    static SessionUsageTotals readUsageTotals(Path sessionDir) {
        JsonObject root = readJsonObject(sessionDir, "usage.json");
        if (root == null) {
            return null;
        }
        SessionUsageTotals totals = new SessionUsageTotals();
        totals.model = firstNonBlankString(root, "primaryModelId", "modelId", "model");
        if (firstPositiveLong(root, KEY_TOTAL_TOKENS_CAMEL, KEY_TOTAL_TOKENS) > 0) {
            addTurnUsage(totals, root);
        } else if (root.has("turns") && root.get("turns").isJsonArray()) {
            for (JsonElement turn : root.getAsJsonArray("turns")) {
                if (turn.isJsonObject()) {
                    addTurnUsage(totals, usageObject(turn.getAsJsonObject()));
                }
            }
        }
        return totals;
    }

    /**
     * Attaches the session's current context occupancy and window to the last assistant
     * message's {@code message.usage}, where the history reload restores the context ring.
     *
     * @param sessionDir Grok session directory
     * @param messages converted history messages, updated in place
     * @param cancellation cancellation signal of the history load
     */
    static void restoreSessionContext(Path sessionDir, List<JsonObject> messages, BooleanSupplier cancellation) {
        if (sessionDir == null || messages == null) {
            return;
        }
        JsonObject lastAssistant = findLastAssistant(messages);
        if (lastAssistant == null) {
            return;
        }
        JsonObject signals = readJsonObject(sessionDir, "signals.json");
        int contextUsed = (int) firstPositiveLong(signals, "contextTokensUsed", "context_tokens_used");
        if (contextUsed <= 0) {
            contextUsed = scanLatestStepContextTokens(sessionDir, cancellation);
        }
        int contextWindow = (int) firstPositiveLong(signals, "contextWindowTokens", "context_window_tokens");
        if (contextWindow <= 0) {
            SessionUsageTotals totals = readUsageTotals(sessionDir);
            contextWindow = resolveContextWindow(totals != null ? totals.model : null);
        }
        if (contextUsed > 0 || contextWindow > 0) {
            attachSessionUsage(lastAssistant, contextUsed, contextWindow);
        }
    }

    /**
     * Same split as {@link GrokContextUsageBuilder#normalizeTurnUsage}, in longs: session
     * totals can exceed the int range that per-call usage fits in.
     */
    private static void addTurnUsage(SessionUsageTotals totals, JsonObject usage) {
        long input = firstPositiveLong(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
        long output = firstPositiveLong(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
        long cacheRead = firstPositiveLong(usage, "cache_read_input_tokens", "cacheReadInputTokens",
                "cached_read_tokens", "cachedReadTokens", "cacheReadTokens", "cached_tokens", "cachedTokens");
        long cacheWrite = firstPositiveLong(usage, "cache_creation_input_tokens", "cacheCreationInputTokens",
                "cached_write_tokens", "cachedWriteTokens", "cacheWriteTokens");
        long nonCacheInput = GrokContextUsageBuilder.inputIncludesCache(usage)
                ? Math.max(0L, input - cacheRead - cacheWrite)
                : input;
        long total = firstPositiveLong(usage, KEY_TOTAL_TOKENS_CAMEL, KEY_TOTAL_TOKENS);
        totals.inputTokens += nonCacheInput;
        totals.outputTokens += output;
        totals.cacheReadTokens += cacheRead;
        totals.cacheWriteTokens += cacheWrite;
        totals.totalTokens += total > 0 ? total : nonCacheInput + cacheRead + cacheWrite + output;
    }

    private static JsonObject findLastAssistant(List<JsonObject> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            JsonObject message = messages.get(i);
            if (message != null && message.has("type") && message.get("type").isJsonPrimitive()
                    && "assistant".equals(message.get("type").getAsString())) {
                return message;
            }
        }
        return null;
    }

    /**
     * Context occupancy of the latest model call. A turn's cumulative usage sums every call
     * in a multi-step turn, so {@code turn_completed} lines never set the ring.
     */
    private static int scanLatestStepContextTokens(Path sessionDir, BooleanSupplier cancellation) {
        Path updatesPath = sessionDir.resolve("updates.jsonl");
        if (!Files.isRegularFile(updatesPath)) {
            return 0;
        }
        int latest = 0;
        try (BufferedReader reader = Files.newBufferedReader(updatesPath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                HistoryCancellation.check(cancellation);
                int stepTokens = stepContextTokens(line);
                if (stepTokens > 0) {
                    latest = stepTokens;
                }
            }
        } catch (CancellationException e) {
            throw e;
        } catch (Exception e) {
            LOG.debug("[GrokSessionCompanionFiles] Failed to read updates.jsonl: " + e.getMessage());
        }
        return latest;
    }

    private static int stepContextTokens(String line) {
        String trimmed = line.trim();
        // Most lines are streaming chunks; only step results and _meta totals matter.
        if (!trimmed.startsWith("{")
                || (!trimmed.contains("response_completed") && !trimmed.contains("_meta"))) {
            return 0;
        }
        try {
            JsonObject obj = JsonParser.parseString(trimmed).getAsJsonObject();
            JsonObject update = obj.has("update") && obj.get("update").isJsonObject()
                    ? obj.getAsJsonObject("update")
                    : obj;
            if ("response_completed".equals(firstNonBlankString(update, "sessionUpdate", "type"))
                    && update.has(KEY_USAGE) && update.get(KEY_USAGE).isJsonObject()) {
                return GrokContextUsageBuilder.extractUsedTokens(update.getAsJsonObject(KEY_USAGE));
            }
            JsonObject meta = jsonObjectField(obj, "_meta");
            if (meta == null) {
                meta = jsonObjectField(update, "_meta");
            }
            return (int) firstPositiveLong(meta, KEY_TOTAL_TOKENS_CAMEL, KEY_TOTAL_TOKENS);
        } catch (Exception ignored) {
            // Skip one malformed line and keep reading the rest.
            return 0;
        }
    }

    private static int resolveContextWindow(String sessionModel) {
        if (sessionModel != null && !sessionModel.isBlank()) {
            return ModelProviderHandler.resolveContextLimit("grok", sessionModel, null);
        }
        Integer configuredDefault = GrokContextWindowResolver.resolve(null);
        return configuredDefault != null && configuredDefault > 0 ? configuredDefault : 0;
    }

    private static void attachSessionUsage(JsonObject lastAssistant, int contextUsed, int contextWindow) {
        JsonObject message = jsonObjectField(lastAssistant, KEY_MESSAGE);
        if (message == null) {
            message = new JsonObject();
        }
        JsonObject usage = jsonObjectField(message, KEY_USAGE);
        if (usage == null) {
            usage = new JsonObject();
        }
        if (contextUsed > 0) {
            usage.addProperty(KEY_TOTAL_TOKENS, contextUsed);
            usage.addProperty("input_tokens", contextUsed);
        }
        if (contextWindow > 0) {
            usage.addProperty("model_context_window", contextWindow);
        }
        message.add(KEY_USAGE, usage);
        lastAssistant.add(KEY_MESSAGE, message);
    }

    private static JsonObject readJsonObject(Path sessionDir, String fileName) {
        if (sessionDir == null) {
            return null;
        }
        Path path = sessionDir.resolve(fileName);
        if (!Files.isRegularFile(path)) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8));
            return parsed != null && parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (Exception e) {
            LOG.debug("[GrokSessionCompanionFiles] Failed to read " + path + ": " + e.getMessage());
            return null;
        }
    }

    private static JsonObject usageObject(JsonObject parent) {
        JsonObject usage = jsonObjectField(parent, KEY_USAGE);
        return usage != null ? usage : parent;
    }

    private static JsonObject jsonObjectField(JsonObject parent, String key) {
        if (parent != null && parent.has(key) && parent.get(key).isJsonObject()) {
            return parent.getAsJsonObject(key);
        }
        return null;
    }

    private static long firstPositiveLong(JsonObject obj, String... keys) {
        if (obj == null) {
            return 0L;
        }
        for (String key : keys) {
            if (!obj.has(key) || obj.get(key).isJsonNull()) {
                continue;
            }
            try {
                long val = obj.get(key).getAsLong();
                if (val > 0L) {
                    return val;
                }
            } catch (Exception ignored) {
                // Ignore a non-numeric value and try the next key.
            }
        }
        return 0L;
    }

    private static String firstNonBlankString(JsonObject obj, String... keys) {
        if (obj == null) {
            return null;
        }
        for (String key : keys) {
            if (!obj.has(key) || !obj.get(key).isJsonPrimitive()) {
                continue;
            }
            String val = obj.get(key).getAsString();
            if (!val.isBlank()) {
                return val.trim();
            }
        }
        return null;
    }
}
