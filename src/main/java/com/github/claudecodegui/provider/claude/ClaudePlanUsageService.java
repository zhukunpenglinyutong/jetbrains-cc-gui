package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Claude plan-usage snapshot builder + resolver.
 *
 * <p>Feeds the ContextBar plan-usage indicator using the same payload shape as
 * Gemini/Codex ({@code capacity_pct} + {@code windows[]}), so the shared
 * {@code GeminiPlanUsageIndicator} renders it unchanged.
 *
 * <p>Two data sources, picked by backend:
 * <ul>
 *   <li><b>z.ai proxy</b> (detected via {@code ANTHROPIC_BASE_URL} host being
 *       {@code z.ai} or a subdomain): probes {@code {origin}/api/monitor/usage/quota/limit}
 *       and parses the {@code TOKENS_LIMIT}/{@code CREDIT_LIMIT} windows (5h + 7d) plus the
 *       {@code TIME_LIMIT} monthly MCP budget. Returns {@code percentage} per window.</li>
 *   <li><b>Real Anthropic (OAuth subscription):</b> the SDK emits
 *       {@code rate_limit_event} ({@code rate_limit_info: {status, resetsAt, utilization}})
 *       during turns; {@link com.github.claudecodegui.session.ClaudeMessageHandler}
 *       caches it via {@link #cacheRateLimitInfo(JsonObject)}.</li>
 * </ul>
 *
 * <p>The webview polls {@code get_claude_plan_usage} (~every 120s, like Gemini).
 */
public final class ClaudePlanUsageService {
    /**
     * Fresh-cache TTL. Set just under the webview's 120s poll cadence so that
     * back-to-back polls (multiple tool windows, manual refresh) dedupe onto a
     * single probe; a regular 120s poll always re-probes.
     */
    static final long ZAI_CACHE_TTL_MS = 115_000L;
    /** Max age for serving a stale cached payload after repeated probe failures. */
    static final long ZAI_STALE_MAX_MS = 30 * 60_000L;
    private static final long HTTP_TIMEOUT_MS = 15_000L;
    private static final Logger LOG = Logger.getInstance(ClaudePlanUsageService.class);

    /** Last rate_limit_event snapshot (real Anthropic). Null until the first event arrives. */
    private static volatile JsonObject cachedRateLimit;

    private static volatile ZaiCache cachedZai;

    /** Test-only seam replacing the real HTTP probe. */
    private static volatile ZaiTransport transportOverride;

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    private ClaudePlanUsageService() {
    }

    /**
     * Cache a {@code rate_limit_event} snapshot from the SDK stream (real Anthropic).
     * Called by {@code ClaudeMessageHandler.handleRateLimit}.
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
     * Resolve the plan-usage payload for the webview poll. Probes the z.ai monitor
     * endpoint on a z.ai backend; otherwise returns the cached rate_limit snapshot
     * (real Anthropic). Falls back to an unavailable marker.
     *
     * <p>The settings service is passed in by the caller (which holds a long-lived
     * instance) — constructing a fresh {@code CodemossSettingsService} per poll would
     * rebuild its whole manager graph every 120s. Settings are still re-read from
     * disk on each call, so edits to {@code settings.json} are picked up.
     */
    public static JsonObject resolvePlanUsagePayload(CodemossSettingsService settingsService) {
        try {
            if (settingsService != null) {
                JsonObject settings = settingsService.readClaudeSettings();
                if (isZaiBackend(settings)) {
                    JsonObject zai = resolveViaZaiMonitor(settings);
                    if (zai != null) {
                        return zai;
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("Claude plan-usage resolve failed, falling back to rate_limit cache: " + e.getMessage());
        }
        JsonObject cached = cachedRateLimit;
        if (cached != null) {
            return cached.deepCopy();
        }
        return unavailable("Claude usage unavailable");
    }

    // ===== z.ai monitor endpoint =====

    /** A z.ai backend is identified by its anthropic-compat base URL host being {@code z.ai} or a subdomain. */
    static boolean isZaiBackend(JsonObject settings) {
        String base = envString(settings, "ANTHROPIC_BASE_URL");
        if (base == null) {
            return false;
        }
        try {
            String host = URI.create(base).getHost();
            if (host == null) {
                return false;
            }
            host = host.toLowerCase(java.util.Locale.ROOT);
            return host.equals("z.ai") || host.endsWith(".z.ai");
        } catch (Exception e) {
            return false;
        }
    }

    static JsonObject resolveViaZaiMonitor(JsonObject settings) {
        return resolveViaZaiMonitor(settings, System.currentTimeMillis());
    }

    static JsonObject resolveViaZaiMonitor(JsonObject settings, long nowMs) {
        String base = envString(settings, "ANTHROPIC_BASE_URL");
        String token = envString(settings, "ANTHROPIC_AUTH_TOKEN");
        if (token == null) {
            token = envString(settings, "ANTHROPIC_API_KEY");
        }
        String url = (base != null && token != null) ? monitorUrl(base) : null;
        if (url == null) {
            return null;
        }
        // Key the cache by endpoint + credential so an account/base-URL switch
        // never serves the previous account's quota.
        String cacheKey = url + '\n' + token;

        ZaiCache c = cachedZai;
        if (c != null && c.key.equals(cacheKey) && nowMs - c.atMs < ZAI_CACHE_TTL_MS) {
            return c.payload.deepCopy();
        }
        try {
            JsonObject body = httpGetJson(url, token);
            JsonObject payload = parseZaiQuota(body);
            if (payload != null) {
                cachedZai = new ZaiCache(nowMs, cacheKey, payload);
                return payload.deepCopy();
            }
        } catch (Exception e) {
            LOG.warn("z.ai quota probe failed: " + e.getMessage());
        }
        // Serve the last good payload while probes keep failing — but only for a
        // bounded window, so a long outage doesn't masquerade as live data.
        if (c != null && c.key.equals(cacheKey) && nowMs - c.atMs < ZAI_STALE_MAX_MS) {
            JsonObject copy = c.payload.deepCopy();
            copy.addProperty("stale", true);
            return copy;
        }
        return null;
    }

    /**
     * Derive {@code <origin>/api/monitor/usage/quota/limit} from the anthropic base URL
     * (port kept). The Bearer token rides along, so plain HTTP is only allowed for
     * loopback targets (local proxies); anything else must be TLS.
     */
    static String monitorUrl(String baseUrl) {
        try {
            URI u = URI.create(baseUrl);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null) {
                return null;
            }
            boolean loopback = host.equalsIgnoreCase("localhost")
                    || host.equals("127.0.0.1")
                    || host.equals("::1");
            if (!"https".equalsIgnoreCase(scheme)
                    && !("http".equalsIgnoreCase(scheme) && loopback)) {
                return null;
            }
            int port = u.getPort();
            String origin = port == -1
                    ? scheme + "://" + host
                    : scheme + "://" + host + ":" + port;
            return origin + "/api/monitor/usage/quota/limit";
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Parse the z.ai {@code /api/monitor/usage/quota/limit} body into the capacity shape.
     * Coding-token windows ({@code CREDIT_LIMIT}/{@code TOKENS_LIMIT}) map to 5h/7d; the
     * {@code TIME_LIMIT} monthly MCP budget maps to a {@code monthly} window. Only limits
     * carrying a {@code percentage} are emitted.
     */
    static JsonObject parseZaiQuota(JsonObject body) {
        if (body == null) {
            return null;
        }
        JsonObject data = body.has("data") && body.get("data").isJsonObject()
                ? body.getAsJsonObject("data") : null;
        if (data == null || !data.has("limits") || !data.get("limits").isJsonArray()) {
            return null;
        }
        String level = asString(data, "level");

        // Two limit types can map to the same window (e.g. TOKENS_LIMIT and
        // CREDIT_LIMIT both with unit=3 → "5h"); merge them, surfacing the worse
        // usage, so the frontend never sees duplicate window ids.
        Map<String, JsonObject> byPeriod = new LinkedHashMap<>();
        for (JsonElement el : data.getAsJsonArray("limits")) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject lim = el.getAsJsonObject();
            Double pct = asDouble(lim, "percentage");
            if (pct == null || !Double.isFinite(pct)) {
                continue;
            }
            pct = clampPct(pct);
            String type = asString(lim, "type");
            String period = zaiPeriod(lim, type);
            Long resetsAtMs = asLong(lim, "nextResetTime", "next_reset_time");
            String resetAt = resetsAtMs != null ? Instant.ofEpochMilli(resetsAtMs).toString() : null;

            JsonObject existing = byPeriod.get(period);
            if (existing != null) {
                if (pct > existing.get("used_pct").getAsDouble()) {
                    existing.addProperty("used_pct", pct);
                }
                if (!existing.has("reset_at") && resetAt != null) {
                    existing.addProperty("reset_at", resetAt);
                }
                continue;
            }

            JsonObject w = new JsonObject();
            w.addProperty("id", period);
            w.addProperty("used_pct", pct);
            if (resetAt != null) {
                w.addProperty("reset_at", resetAt);
            }
            w.addProperty("period_type", period);
            byPeriod.put(period, w);
        }
        if (byPeriod.isEmpty()) {
            return null;
        }

        Double primary5h = null;
        double maxPct = 0;
        for (JsonObject w : byPeriod.values()) {
            double pct = w.get("used_pct").getAsDouble();
            if ("5h".equals(w.get("id").getAsString())) {
                primary5h = pct;
            }
            if (pct > maxPct) {
                maxPct = pct;
            }
        }

        double capacity = primary5h != null ? primary5h : maxPct;
        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", "claude");
        out.addProperty("source", "zai-quota-limit");
        out.addProperty("capacity_pct", capacity);
        out.addProperty("period_type", byPeriod.keySet().iterator().next());
        JsonArray arr = new JsonArray();
        for (JsonObject w : byPeriod.values()) {
            arr.add(w);
        }
        out.add("windows", arr);
        if (level != null) {
            out.addProperty("level", level);
        }
        return out;
    }

    /**
     * Map a z.ai limit to a window id/period. Observed z.ai payloads use
     * unit 3=hours (number=5 → 5h), unit 6=weeks (number=1 → 7d) and unit 4=days
     * (number=7 → 7d). The {@code number} field is assumed to match those shapes —
     * a hypothetical unit=4/number=1 (1-day) window would still be labelled 7d.
     */
    static String zaiPeriod(JsonObject lim, String type) {
        if (type != null && type.toUpperCase().contains("TIME")) {
            return "monthly";
        }
        Integer unit = asInt(lim, "unit");
        if (unit == null) {
            return "5h";
        }
        switch (unit) {
            case 3:
                return "5h";
            case 6:
            case 4:
                return "7d";
            default:
                return "5h";
        }
    }

    private static JsonObject httpGetJson(String url, String token) throws Exception {
        ZaiTransport override = transportOverride;
        if (override != null) {
            return override.get(url, token);
        }
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofMillis(HTTP_TIMEOUT_MS))
                .header("Authorization", "Bearer " + token)
                .header("Accept", "application/json")
                .header("User-Agent", "jetbrains-cc-gui-claude-plan-usage")
                .GET()
                .build();
        HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new IllegalStateException("z.ai monitor HTTP " + resp.statusCode());
        }
        return JsonParser.parseString(resp.body()).getAsJsonObject();
    }

    /** Test-only: replace the HTTP transport. Pass null to restore the real one. */
    static void setZaiTransportForTests(ZaiTransport transport) {
        transportOverride = transport;
    }

    /** Test-only: drop the cached z.ai payload. */
    static void resetZaiCacheForTests() {
        cachedZai = null;
    }

    /** Transport seam for the z.ai monitor probe — production hits HTTP, tests substitute. */
    interface ZaiTransport {
        JsonObject get(String url, String token) throws Exception;
    }

    // ===== real Anthropic rate_limit_event =====

    static JsonObject buildCapacityPayload(JsonObject rateLimitInfo) {
        Double utilization = asDouble(rateLimitInfo, "utilization");
        if (utilization == null || !Double.isFinite(utilization)) {
            return null;
        }
        // The CLI documents utilization as a fraction of the window (0-1, and
        // exceeding 1 when over capacity), so scale it to a percent. The <= 10
        // guard only protects against a hypothetical already-percent payload
        // (0-100) from being scaled twice.
        double pct = clampPct(utilization <= 10.0 ? utilization * 100.0 : utilization);

        // resetsAt is unix epoch SECONDS in the CLI schema (the CLI computes
        // `resetsAt - Date.now()/1000`), not millis — convert before use.
        Long resetsAtSec = asLong(rateLimitInfo, "resetsAt", "resets_at", "resetAt");
        Long resetsAtMs = resetsAtSec != null ? resetsAtSec * 1000L : null;
        String resetAt = resetsAtMs != null ? Instant.ofEpochMilli(resetsAtMs).toString() : null;
        String periodType = periodTypeFromRateLimit(rateLimitInfo, resetsAtMs);

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

    /**
     * Window classification prefers the CLI-provided {@code rateLimitType}
     * ({@code five_hour} / {@code seven_day} / {@code seven_day_sonnet} / …) over
     * the reset-delta heuristic, which only survives as a fallback.
     */
    static String periodTypeFromRateLimit(JsonObject rateLimitInfo, Long resetsAtMs) {
        String type = asString(rateLimitInfo, "rateLimitType");
        if (type == null) {
            type = asString(rateLimitInfo, "rate_limit_type");
        }
        if (type != null) {
            if (type.startsWith("five_hour")) {
                return "5h";
            }
            if (type.startsWith("seven_day")) {
                return "7d";
            }
        }
        return resetsAtMs != null ? periodTypeFromResetMs(resetsAtMs) : "5h";
    }

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

    // ===== accessors =====

    private static String envString(JsonObject settings, String key) {
        if (settings == null || !settings.has("env") || !settings.get("env").isJsonObject()) {
            return null;
        }
        JsonObject env = settings.getAsJsonObject("env");
        if (!env.has(key) || env.get(key).isJsonNull()) {
            return null;
        }
        return env.get(key).getAsString();
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

    private static Integer asInt(JsonObject o, String key) {
        if (o.has(key) && o.get(key).isJsonPrimitive() && !o.get(key).isJsonNull()) {
            try {
                return o.get(key).getAsInt();
            } catch (RuntimeException ignored) {
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

    private static final class ZaiCache {
        final long atMs;
        final String key;
        final JsonObject payload;

        ZaiCache(long atMs, String key, JsonObject payload) {
            this.atMs = atMs;
            this.key = key;
            this.payload = payload;
        }
    }

}
