package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * OpenCode Zen subscription via the opencode.ai anthropic-compat backend
 * ({@code https://opencode.ai/zen/v1} or {@code …/zen/go/v1} — same origin).
 *
 * <p>Probes {@code {origin}/zen/go/v1/usage}: {@code usage} carries one
 * optional entry per billing window — {@code rolling} (5h), {@code weekly},
 * {@code monthly} — each reporting {@code percent} (used percent), a
 * {@code status} ({@code ok} / {@code active} / {@code rate-limited}) and an
 * ISO {@code resetsAt}. At least one window must parse.
 */
public final class OpenCodeUsageVendor implements RelayUsageVendor {

    private static final String USAGE_PATH = "/zen/go/v1/usage";

    @Override
    public String id() {
        return "opencode";
    }

    @Override
    public boolean matches(String host, String path) {
        return host != null && host.equalsIgnoreCase("opencode.ai");
    }

    @Override
    public JsonObject probe(RelayUsageEnv env) throws Exception {
        String origin = RelayUsageHttp.secureOrigin(env.baseUrl());
        if (origin == null) {
            return null;
        }
        JsonObject body = RelayUsageHttp.getJson(origin + USAGE_PATH, env.token());
        return parseUsage(body);
    }

    /** Parse the usage body into the capacity shape (rolling→5h, weekly→7d, monthly). */
    static JsonObject parseUsage(JsonObject body) {
        if (body == null) {
            return null;
        }
        JsonObject usage = RelayUsageJson.asObject(body, "usage");
        if (usage == null) {
            return null;
        }
        List<JsonObject> windows = new ArrayList<>();
        addWindow(windows, usage, "rolling", "5h");
        addWindow(windows, usage, "weekly", "7d");
        addWindow(windows, usage, "monthly", "monthly");
        if (windows.isEmpty()) {
            return null;
        }
        return RelayUsageJson.capacityPayload("opencode-zen-usage", windows, null);
    }

    private static void addWindow(List<JsonObject> windows, JsonObject usage, String key, String id) {
        JsonObject entry = RelayUsageJson.asObject(usage, key);
        if (entry == null) {
            return;
        }
        Double pct = RelayUsageJson.asDouble(entry, "percent");
        boolean rateLimited = isRateLimited(RelayUsageJson.asString(entry, "status"));
        if ((pct == null || !Double.isFinite(pct)) && !rateLimited) {
            return;
        }
        // A rate-limited window is fully consumed even if the reported percent lags behind.
        double usedPct = rateLimited
                ? 100.0
                : RelayUsageJson.clampPct(pct == null ? 0.0 : pct);
        windows.add(RelayUsageJson.window(id, usedPct,
                isoToEpochMs(RelayUsageJson.asString(entry, "resetsAt"))));
    }

    /** {@code true} for the API's "rate-limited" status (hyphen/underscore tolerant). */
    static boolean isRateLimited(String status) {
        if (status == null) {
            return false;
        }
        String normalized = status.trim().toLowerCase(Locale.ROOT)
                .replace('_', '-');
        return "rate-limited".equals(normalized);
    }

    private static Long isoToEpochMs(String iso) {
        if (iso == null || iso.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(iso).toEpochMilli();
        } catch (RuntimeException e) {
            return null;
        }
    }
}
