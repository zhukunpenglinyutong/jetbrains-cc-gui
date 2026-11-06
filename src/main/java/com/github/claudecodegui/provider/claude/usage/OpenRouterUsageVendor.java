package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

/**
 * OpenRouter prepaid credits via the openrouter.ai anthropic-compat backend.
 *
 * <p>Probes {@code {origin}/api/v1/key}: the current-key endpoint that works
 * with the ordinary inference key configured in {@code ANTHROPIC_AUTH_TOKEN}
 * ({@code /api/v1/credits} needs a management key, which cannot call models,
 * so a regular setup would only ever see HTTP 403). The response reports
 * {@code limit_remaining}/{@code usage}/{@code limit} in USD; a key without a
 * spend limit has {@code limit_remaining: null} and renders nothing.
 */
public final class OpenRouterUsageVendor extends BalanceUsageVendor {

    private static final String USAGE_PATH = "/api/v1/key";

    @Override
    public String id() {
        return "openrouter";
    }

    @Override
    public boolean matches(String host, String path) {
        return hostMatches(host, "openrouter.ai");
    }

    @Override
    protected String usagePath(String host) {
        return USAGE_PATH;
    }

    /** Parse the current-key body into remaining/total/used (USD). */
    @Override
    protected RelayUsageJson.Balance parseBalance(JsonObject body, String host) {
        if (body == null) {
            return null;
        }
        JsonObject data = RelayUsageJson.asObject(body, "data");
        if (data == null) {
            data = body;
        }
        Double remaining = RelayUsageJson.asDouble(data, "limit_remaining");
        // limit_remaining is null when the key has no spend limit: there is no
        // remaining budget to render, and reporting usage alone is not a
        // balance, so the indicator stays hidden.
        if (remaining == null || !Double.isFinite(remaining)) {
            return null;
        }
        Double used = RelayUsageJson.asDouble(data, "usage");
        if (used != null && !Double.isFinite(used)) {
            used = null;
        }
        Double total = RelayUsageJson.asDouble(data, "limit");
        if (total != null && !Double.isFinite(total)) {
            total = null;
        }
        return new RelayUsageJson.Balance(remaining, total, used, "USD");
    }
}
