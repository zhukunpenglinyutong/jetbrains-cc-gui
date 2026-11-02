package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Builds a {@code ContextUsageData}-compatible payload for the Grok provider.
 * Grok ACP only exposes aggregate token usage (not Claude's category breakdown),
 * so we synthesize: used conversation tokens + free space within the model limit.
 */
public final class GrokContextUsageBuilder {

    private static final String KEY_THINKING_TOKENS = "thinking_tokens";
    private static final String KEY_CACHED_WRITE_TOKENS = "cached_write_tokens";
    private static final String KEY_CACHED_WRITE_TOKENS_CAMEL = "cachedWriteTokens";
    private static final String KEY_CACHE_WRITE_TOKENS_ALIAS = "cacheWriteTokens";
    private static final String KEY_CACHE_READ_TOKENS_ALIAS = "cacheReadTokens";
    private static final String KEY_CACHE_CREATION_INPUT_TOKENS = "cache_creation_input_tokens";
    private static final String KEY_CACHE_READ_INPUT_TOKENS = "cache_read_input_tokens";

    private GrokContextUsageBuilder() {
    }

    /**
     * @param usedTokens tokens used in the current/last turn (0 if unknown)
     * @param maxTokens  model context window limit
     * @param model      model id for display
     */
    public static JsonObject build(int usedTokens, int maxTokens, String model) {
        int used = Math.max(0, usedTokens);
        int max = Math.max(1, maxTokens);
        if (used > max) {
            used = max;
        }
        int free = Math.max(0, max - used);
        double percentage = (100.0 * used) / max;

        JsonObject root = new JsonObject();
        root.addProperty("success", true);
        root.addProperty("totalTokens", used);
        root.addProperty("maxTokens", max);
        root.addProperty("rawMaxTokens", max);
        root.addProperty("percentage", Math.round(percentage * 10.0) / 10.0);
        root.addProperty("model", model != null ? model : "");
        root.addProperty("isAutoCompactEnabled", false);
        root.addProperty("source", "grok-synthesized");

        JsonArray categories = new JsonArray();
        JsonObject usedCat = new JsonObject();
        usedCat.addProperty("name", "Conversation");
        usedCat.addProperty("tokens", used);
        usedCat.addProperty("color", "claude");
        categories.add(usedCat);

        JsonObject freeCat = new JsonObject();
        freeCat.addProperty("name", "Free space");
        freeCat.addProperty("tokens", free);
        freeCat.addProperty("color", "inactive");
        categories.add(freeCat);
        root.add("categories", categories);

        // Minimal 1-row grid for the dialog heatmap.
        JsonArray gridRows = new JsonArray();
        JsonArray row = new JsonArray();
        row.add(gridCell("claude", used > 0, "Conversation", used, percentage, used > 0 ? 1.0 : 0.0));
        double freePct = 100.0 - percentage;
        row.add(gridCell("inactive", false, "Free space", free, freePct, free > 0 ? Math.min(1.0, free / (double) max) : 0.0));
        gridRows.add(row);
        root.add("gridRows", gridRows);

        root.add("memoryFiles", new JsonArray());
        root.add("mcpTools", new JsonArray());
        root.add("agents", new JsonArray());

        return root;
    }

    private static JsonObject gridCell(
            String color,
            boolean isFilled,
            String categoryName,
            int tokens,
            double percentage,
            double squareFullness
    ) {
        JsonObject cell = new JsonObject();
        cell.addProperty("color", color);
        cell.addProperty("isFilled", isFilled);
        cell.addProperty("categoryName", categoryName);
        cell.addProperty("tokens", tokens);
        cell.addProperty("percentage", Math.round(percentage * 10.0) / 10.0);
        cell.addProperty("squareFullness", squareFullness);
        return cell;
    }

    /**
     * Normalizes a Grok usage JSON object to OpenAI snake_case keys.
     *
     * @param usage Raw Grok usage JSON object
     * @return normalized snake_case usage object, or null if no token fields are found
     */
    public static JsonObject normalizeUsageToSnakeCase(JsonObject usage) {
        if (usage == null) {
            return null;
        }
        // Nested { usage: {...} }
        if (usage.has("usage") && usage.get("usage").isJsonObject()
                && firstPositiveInt(usage, "total_tokens", "totalTokens", "input_tokens", "inputTokens") <= 0) {
            JsonObject nested = normalizeUsageToSnakeCase(usage.getAsJsonObject("usage"));
            if (nested != null) {
                return nested;
            }
        }

        int total = firstPositiveInt(usage, "total_tokens", "totalTokens");
        int input = firstPositiveInt(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
        int output = firstPositiveInt(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
        int thought = firstPositiveInt(
                usage,
                "thought_tokens",
                "thoughtTokens",
                KEY_THINKING_TOKENS,
                "thinkingTokens",
                "reasoning_tokens",
                "reasoningTokens"
        );
        int cachedWrite = firstPositiveInt(
                usage,
                KEY_CACHED_WRITE_TOKENS,
                KEY_CACHED_WRITE_TOKENS_CAMEL,
                KEY_CACHE_WRITE_TOKENS_ALIAS,
                KEY_CACHE_CREATION_INPUT_TOKENS,
                "cacheCreationInputTokens"
        );
        int cachedRead = firstPositiveInt(
                usage,
                "cached_read_tokens",
                "cachedReadTokens",
                KEY_CACHE_READ_TOKENS_ALIAS,
                KEY_CACHE_READ_INPUT_TOKENS,
                "cacheReadInputTokens",
                "cached_tokens",
                "cachedTokens"
        );

        if (total <= 0 && input <= 0 && output <= 0 && thought <= 0 && cachedWrite <= 0 && cachedRead <= 0) {
            return null;
        }

        // Snapshots always carry cache-inclusive input (cached_*_tokens are a subset of it), so
        // normalizeTurnUsage can split the cache back out without guessing from the total.
        int inclusiveInput = inputIncludesCache(usage)
                ? Math.max(input, cachedRead + cachedWrite)
                : input + cachedRead + cachedWrite;

        JsonObject out = new JsonObject();
        if (inclusiveInput > 0) {
            out.addProperty("input_tokens", inclusiveInput);
        }
        if (output > 0) {
            out.addProperty("output_tokens", output);
        }
        if (thought > 0) {
            out.addProperty("thought_tokens", thought);
        }
        if (cachedWrite > 0) {
            out.addProperty(KEY_CACHED_WRITE_TOKENS, cachedWrite);
        }
        if (cachedRead > 0) {
            out.addProperty("cached_read_tokens", cachedRead);
        }
        int contextWindow = firstPositiveInt(usage, "model_context_window", "maxTokens", "limit");
        if (contextWindow > 0) {
            out.addProperty("model_context_window", contextWindow);
        }
        // Reasoning is part of output (Grok reports totalTokens = inputTokens + outputTokens).
        int resolvedTotal = total > 0
                ? total
                : inclusiveInput + Math.max(output, thought);
        out.addProperty("total_tokens", resolvedTotal);
        return out;
    }

    /**
     * Whether the reported input already counts the cached prompt tokens. Grok ACP camelCase
     * {@code inputTokens} and OpenAI-style prompt tokens include them; only the Claude layout
     * (snake {@code input_tokens} next to {@code cache_read_input_tokens} /
     * {@code cache_creation_input_tokens}) reports cache reads and writes on top of the input.
     */
    static boolean inputIncludesCache(JsonObject usage) {
        boolean hasSnakeInput = firstPositiveInt(usage, "input_tokens") > 0;
        boolean hasClaudeCacheField =
                firstPositiveInt(usage, KEY_CACHE_READ_INPUT_TOKENS, KEY_CACHE_CREATION_INPUT_TOKENS) > 0;
        return !(hasSnakeInput && hasClaudeCacheField);
    }

    /**
     * Normalizes whole-turn Grok usage into the canonical Claude turnUsage schema.
     * Cache-inclusive input is split into non-cached input plus cache reads and writes.
     *
     * @param usage Raw Grok turn usage JSON object
     * @return canonical Claude-schema turnUsage JSON object, or null if no token fields are found
     */
    public static JsonObject normalizeTurnUsage(JsonObject usage) {
        if (usage == null) {
            return null;
        }
        if (usage.has("usage") && usage.get("usage").isJsonObject()
                && firstPositiveInt(usage, "total_tokens", "totalTokens", "input_tokens", "inputTokens") <= 0) {
            JsonObject nested = normalizeTurnUsage(usage.getAsJsonObject("usage"));
            if (nested != null) {
                return nested;
            }
        }

        int total = firstPositiveInt(usage, "total_tokens", "totalTokens");
        int rawInput = firstPositiveInt(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
        int output = firstPositiveInt(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
        int thinking = firstPositiveInt(
                usage,
                KEY_THINKING_TOKENS,
                "thinkingTokens",
                "thought_tokens",
                "thoughtTokens",
                "reasoning_tokens",
                "reasoningTokens"
        );
        int cacheRead = firstPositiveInt(
                usage,
                KEY_CACHE_READ_INPUT_TOKENS,
                "cacheReadInputTokens",
                "cached_read_tokens",
                "cachedReadTokens",
                KEY_CACHE_READ_TOKENS_ALIAS,
                "cached_tokens",
                "cachedTokens"
        );
        int cacheWrite = firstPositiveInt(
                usage,
                KEY_CACHE_CREATION_INPUT_TOKENS,
                "cacheCreationInputTokens",
                KEY_CACHED_WRITE_TOKENS,
                KEY_CACHED_WRITE_TOKENS_CAMEL,
                KEY_CACHE_WRITE_TOKENS_ALIAS
        );

        if (total <= 0 && rawInput <= 0 && output <= 0 && thinking <= 0 && cacheRead <= 0 && cacheWrite <= 0) {
            return null;
        }

        int nonCacheInput = inputIncludesCache(usage)
                ? Math.max(0, rawInput - cacheRead - cacheWrite)
                : rawInput;
        int resolvedTotal = total > 0
                ? total
                : (nonCacheInput + cacheRead + cacheWrite + Math.max(output, thinking));

        JsonObject out = new JsonObject();
        out.addProperty("input_tokens", nonCacheInput);
        out.addProperty(KEY_CACHE_READ_INPUT_TOKENS, cacheRead);
        out.addProperty(KEY_CACHE_CREATION_INPUT_TOKENS, cacheWrite);
        out.addProperty("output_tokens", output);
        out.addProperty(KEY_THINKING_TOKENS, thinking);
        out.addProperty("total_tokens", resolvedTotal);
        return out;
    }

    /**
     * Extracts the used-token total from a Grok or ACP usage JSON object.
     *
     * @param usage Grok or ACP usage JSON object
     * @return extracted used token count
     */
    public static int extractUsedTokens(JsonObject usage) {
        // A normalized snapshot always carries a total once any token field is present.
        JsonObject normalized = normalizeUsageToSnakeCase(usage);
        return normalized != null ? firstPositiveInt(normalized, "total_tokens") : 0;
    }

    /** First finite non-null number &gt; 0 among keys (or 0). Snake_case keys should be listed first. */
    static int firstPositiveInt(JsonObject obj, String... keys) {
        if (obj == null || keys == null) {
            return 0;
        }
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
                continue;
            }
            try {
                int n = obj.get(key).getAsInt();
                if (n > 0) {
                    return n;
                }
            } catch (Exception ignored) {
                // non-numeric
            }
        }
        return 0;
    }
}
