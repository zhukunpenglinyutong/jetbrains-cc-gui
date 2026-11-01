package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.util.TurnUsageAccumulator;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Converts the token usage OpenCode stores on an assistant message into the Claude
 * usage schema (input_tokens excludes cache reads).
 *
 * <p>Mirrors {@code ai-bridge/services/opencode/usage.js}, which does the same for
 * live {@code step_finish} events.</p>
 */
final class OpenCodeUsageConverter {

    private OpenCodeUsageConverter() {
    }

    /**
     * @param msg   assistant message data ({@code tokens}, {@code cost})
     * @param parts the message's parts; a {@code step-finish} part also carries tokens
     * @return usage with an optional {@code cost_usd}, or null without positive figures
     */
    static JsonObject fromAssistantMessage(JsonObject msg, List<JsonObject> parts) {
        JsonObject source = msg;
        JsonObject usage = fromTokens(object(msg, "tokens"));
        for (int i = parts == null ? -1 : parts.size() - 1; usage == null && i >= 0; i--) {
            source = parts.get(i);
            usage = fromTokens(object(source, "tokens"));
        }
        if (usage == null) {
            source = msg;
            usage = fromUsageObject(object(msg, "usage"));
        }
        if (usage != null) {
            attachCost(usage, source);
        }
        return usage;
    }

    /** OpenCode prices each step itself; keep that figure next to the tokens it priced. */
    private static void attachCost(JsonObject usage, JsonObject source) {
        JsonElement cost = source == null ? null : source.get("cost");
        if (cost != null && cost.isJsonPrimitive() && cost.getAsJsonPrimitive().isNumber()
                && cost.getAsDouble() >= 0) {
            usage.addProperty(TurnUsageAccumulator.COST_KEY, cost.getAsDouble());
        }
    }

    private static JsonObject fromTokens(JsonObject tokens) {
        if (tokens == null) {
            return null;
        }
        long rawInput = count(tokens, "input");
        long output = count(tokens, "output");
        long reasoning = count(tokens, "reasoning");
        long rawTotal = count(tokens, "total");
        JsonObject cache = object(tokens, "cache");
        long cacheRead = cache != null ? count(cache, "read") : count(tokens, "cache_read");
        long cacheWrite = cache != null ? count(cache, "write") : count(tokens, "cache_write");

        // OpenCode's input is cache-exclusive; a backend whose input already includes
        // cache.read shows up as a total that adds up without cache.read.
        boolean inputIncludesCache = rawTotal > 0 && cacheRead > 0 && rawInput >= cacheRead
                && rawInput + cacheWrite + output + reasoning == rawTotal;
        long input = inputIncludesCache ? rawInput - cacheRead : rawInput;
        long total = rawTotal > 0 ? rawTotal : input + cacheRead + cacheWrite + output + reasoning;
        return build(input, output, cacheRead, cacheWrite, reasoning, total);
    }

    private static JsonObject fromUsageObject(JsonObject raw) {
        if (raw == null) {
            return null;
        }
        if (raw.has("prompt_tokens") || raw.has("completion_tokens")) {
            long prompt = count(raw, "prompt_tokens");
            long output = count(raw, "completion_tokens");
            JsonObject details = object(raw, "prompt_tokens_details");
            long cacheRead = details != null ? count(details, "cached_tokens") : count(raw, "cached_tokens");
            long input = prompt >= cacheRead ? prompt - cacheRead : prompt;
            long total = count(raw, "total_tokens");
            return build(input, output, cacheRead, 0, 0, total > 0 ? total : input + cacheRead + output);
        }
        long input = count(raw, "input_tokens");
        long output = count(raw, "output_tokens");
        long cacheRead = count(raw, "cache_read_input_tokens");
        long cacheWrite = count(raw, "cache_creation_input_tokens");
        long thinking = count(raw, "thinking_tokens");
        long total = count(raw, "total_tokens");
        return build(input, output, cacheRead, cacheWrite, thinking,
                total > 0 ? total : input + cacheRead + cacheWrite + output + thinking);
    }

    private static JsonObject build(long input, long output, long cacheRead, long cacheWrite,
                                    long reasoning, long total) {
        if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && total <= 0) {
            return null;
        }
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", input);
        usage.addProperty("output_tokens", output);
        usage.addProperty("cache_read_input_tokens", cacheRead);
        usage.addProperty("cache_creation_input_tokens", cacheWrite);
        usage.addProperty("total_tokens", total);
        if (reasoning > 0) {
            usage.addProperty("thinking_tokens", reasoning);
        }
        return usage;
    }

    private static JsonObject object(JsonObject parent, String key) {
        if (parent == null || !parent.has(key) || !parent.get(key).isJsonObject()) {
            return null;
        }
        return parent.getAsJsonObject(key);
    }

    private static long count(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || !obj.get(key).isJsonPrimitive()) {
            return 0L;
        }
        try {
            return Math.max(0L, obj.get(key).getAsLong());
        } catch (RuntimeException e) {
            return 0L;
        }
    }
}
