package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.time.Instant;

/**
 * Claude plan-usage snapshot builder + cache.
 *
 * <p>Feeds the ContextBar plan-usage indicator using the same payload shape as
 * Gemini/Codex ({@code capacity_pct} + {@code windows[]}), so the shared
 * {@code GeminiPlanUsageIndicator} renders it unchanged.
 *
 * <p>Data source on a real Anthropic (OAuth subscription) backend: the SDK emits
 * {@code rate_limit_event} messages ({@code rate_limit_info: {status, resetsAt, utilization}})
 * during turns. {@link com.github.claudecodegui.session.ClaudeMessageHandler} extracts the
 * {@code rate_limit_info} and calls {@link #cacheRateLimitInfo(JsonObject)} here. The webview
 * polls {@code get_claude_plan_usage} (~every 120s, like Gemini) and this service returns the
 * freshest cached snapshot.
 *
 * <p>Note: {@code rate_limit_event} only fires on real Anthropic (OAuth subscription)
 * backends — third-party proxies do not emit it, so the bar stays hidden there.
 */
public final class ClaudePlanUsageService {
    private static final Logger LOG = Logger.getInstance(ClaudePlanUsageService.class);

    /** Last rate_limit_event snapshot (real Anthropic). Null until the first event arrives. */
    private static volatile JsonObject cachedRateLimit;

    private ClaudePlanUsageService() {
    }

    /**
     * Cache a {@code rate_limit_event} snapshot from the SDK stream (real Anthropic).
     * Called by {@code ClaudeMessageHandler.handleRateLimit}.
     *
     * @param rateLimitInfo the {@code rate_limit_info} object
     *                      ({@code {status, resetsAt?, utilization?}})
     */
    public static void cacheRateLimitInfo(JsonObject rateLimitInfo) {
        if (rateLimitInfo == null) {
            return;
        }
        try {
            JsonObject payload = buildCapacityPayload(rateLimitInfo);
            if (payload != null) {
                cachedRateLimit = payload;
            }
        } catch (Exception e) {
            LOG.warn("Failed to cache Claude rate_limit_event: " + e.getMessage());
        }
    }

    /**
     * Resolve the plan-usage payload for the webview poll. Returns the cached
     * rate_limit snapshot if one is available, otherwise an unavailable marker.
     */
    public static JsonObject resolvePlanUsagePayload() {
        JsonObject cached = cachedRateLimit;
        if (cached != null) {
            return cached.deepCopy();
        }
        return unavailable("Claude usage unavailable");
    }

    /**
     * Build the Gemini/Codex-compatible capacity payload from a single
     * {@code rate_limit_info} object.
     *
     * <p>{@code utilization} is a 0–1 fraction on Anthropic subscriptions; values &gt; 1 are
     * treated defensively as already-percent. {@code resetsAt} is epoch milliseconds.
     */
    static JsonObject buildCapacityPayload(JsonObject rateLimitInfo) {
        Double utilization = asDouble(rateLimitInfo, "utilization");
        if (utilization == null || !Double.isFinite(utilization)) {
            return null;
        }
        double pct = clampPct(utilization <= 1.0 ? utilization * 100.0 : utilization);

        Long resetsAtMs = asLong(rateLimitInfo, "resetsAt", "resets_at", "resetAt");
        String resetAt = resetsAtMs != null ? Instant.ofEpochMilli(resetsAtMs).toString() : null;
        String periodType = resetsAtMs != null ? periodTypeFromResetMs(resetsAtMs) : "5h";

        JsonObject window = new JsonObject();
        window.addProperty("id", periodType);
        window.addProperty("used_pct", pct);
        if (resetAt != null) {
            window.addProperty("reset_at", resetAt);
        }
        window.addProperty("period_type", periodType);
        JsonArray windows = new JsonArray();
        windows.add(window);

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", "claude");
        out.addProperty("source", "sdk-rate-limit");
        out.addProperty("capacity_pct", pct);
        if (resetAt != null) {
            out.addProperty("reset_at", resetAt);
        }
        out.addProperty("period_type", periodType);
        out.add("windows", windows);
        String status = asString(rateLimitInfo, "status");
        if (status != null) {
            out.addProperty("rate_limit_status", status);
        }
        return out;
    }

    /** Derive a 5h/7d window label from the reset timestamp's distance from now. */
    static String periodTypeFromResetMs(long resetsAtMs) {
        long deltaMs = resetsAtMs - System.currentTimeMillis();
        if (deltaMs <= 6L * 60 * 60 * 1000) {
            return "5h";
        }
        return "7d";
    }

    static double clampPct(double v) {
        if (!Double.isFinite(v)) {
            return 0;
        }
        return Math.max(0, Math.min(100, v));
    }

    static JsonObject unavailable(String message) {
        JsonObject out = new JsonObject();
        out.addProperty("present", false);
        out.addProperty("unavailable", true);
        out.addProperty("provider", "claude");
        out.addProperty("message", message);
        return out;
    }

    private static Double asDouble(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o.has(k) && o.get(k).isJsonPrimitive() && !o.get(k).isJsonNull()) {
                try {
                    return o.get(k).getAsDouble();
                } catch (RuntimeException ignored) {
                }
            }
        }
        return null;
    }

    private static Long asLong(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o.has(k) && o.get(k).isJsonPrimitive() && !o.get(k).isJsonNull()) {
                try {
                    return o.get(k).getAsLong();
                } catch (RuntimeException ignored) {
                }
            }
        }
        return null;
    }

    private static String asString(JsonObject o, String key) {
        if (o.has(key) && o.get(key).isJsonPrimitive() && !o.get(key).isJsonNull()) {
            return o.get(key).getAsString();
        }
        return null;
    }
}
