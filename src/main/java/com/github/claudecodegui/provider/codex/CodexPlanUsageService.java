package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.service.CodexSubscriptionQuotaService;
import com.github.claudecodegui.settings.CodexProviderManager;
import com.github.claudecodegui.settings.SessionSupplierCatalog;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.time.Instant;
import java.util.concurrent.CompletableFuture;

/**
 * Codex plan-usage snapshot builder + resolver for the ContextBar indicator.
 *
 * <p>Adapts {@link CodexSubscriptionQuotaService} snapshots (sourced from recent
 * {@code ~/.codex/sessions/*.jsonl} {@code token_count} events and
 * {@code chatgpt.com/backend-api/wham/usage}) into the shared capacity payload
 * contract ({@code capacity_pct}, {@code reset_at}, {@code period_type},
 * {@code windows[]}) rendered by {@code PlanUsageIndicator}.
 *
 * <p>Respects per-conversation supplier bindings: tabs bound to a managed API-key
 * or relay supplier report {@code api_key_mode} unavailable instead of leaking
 * the global ChatGPT OAuth subscription quota.
 */
public final class CodexPlanUsageService {

    static final String PROVIDER = "codex";
    static final String API_KEY_MODE_REASON = "api_key_mode";

    private CodexPlanUsageService() {
    }

    /**
     * Resolve the Codex plan-usage capacity payload asynchronously for the given
     * conversation supplier binding ({@code null} = global active Codex mode).
     */
    public static CompletableFuture<JsonObject> resolvePlanUsagePayloadAsync(
            CodexSubscriptionQuotaService quotaService,
            String supplierId
    ) {
        if (isManagedSupplierBinding(supplierId)) {
            return CompletableFuture.completedFuture(
                    unavailable("API key mode has no subscription quota", API_KEY_MODE_REASON));
        }
        if (quotaService == null) {
            return CompletableFuture.completedFuture(unavailable("Codex usage unavailable", null));
        }
        return quotaService.getQuotaSnapshot()
                .thenApply(CodexPlanUsageService::toCapacityPayload)
                .exceptionally(error -> {
                    Throwable cause = error.getCause() != null ? error.getCause() : error;
                    String msg = cause != null && cause.getMessage() != null && !cause.getMessage().isBlank()
                            ? cause.getMessage()
                            : "Codex usage unavailable";
                    return unavailable(msg, null);
                });
    }

    /**
     * True when the conversation is explicitly bound to a non-CLI-login (managed
     * API-key / relay) Codex supplier, which has no ChatGPT subscription quota.
     */
    static boolean isManagedSupplierBinding(String supplierId) {
        if (supplierId == null || supplierId.isBlank()) {
            return false;
        }
        if (CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(supplierId)
                || SessionSupplierCatalog.UNAVAILABLE.equals(supplierId)) {
            return false;
        }
        return true;
    }

    /**
     * Convert a {@link CodexSubscriptionQuotaService} payload into the shared
     * {@code PlanUsageIndicator} capacity payload shape.
     */
    public static JsonObject toCapacityPayload(JsonObject quotaSnapshot) {
        if (quotaSnapshot == null) {
            return unavailable("Codex usage unavailable", null);
        }
        String status = readString(quotaSnapshot, "status");
        if (!"ok".equals(status)) {
            String error = readString(quotaSnapshot, "error");
            String reasonCode = readString(quotaSnapshot, "reasonCode");
            return unavailable(
                    error != null && !error.isBlank() ? error : "Codex usage unavailable",
                    reasonCode);
        }

        JsonObject rawWindows = readObject(quotaSnapshot, "windows");
        if (rawWindows == null) {
            return unavailable("Codex usage unavailable", null);
        }

        JsonArray windows = new JsonArray();
        JsonObject fiveHour = toCapacityWindow("5h", readObject(rawWindows, "fiveHour"));
        JsonObject weekly = toCapacityWindow("7d", readObject(rawWindows, "weekly"));
        if (fiveHour != null) {
            windows.add(fiveHour);
        }
        if (weekly != null) {
            windows.add(weekly);
        }
        if (windows.isEmpty()) {
            return unavailable("Codex usage unavailable", null);
        }

        JsonObject binding = pickBindingWindow(windows);
        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", PROVIDER);
        String source = readString(quotaSnapshot, "source");
        out.addProperty("source", source != null && !source.isBlank() ? source : PROVIDER);
        out.addProperty("capacity_pct", binding.get("used_pct").getAsDouble());
        out.addProperty("period_type", binding.get("period_type").getAsString());
        if (binding.has("reset_at") && !binding.get("reset_at").isJsonNull()) {
            out.addProperty("reset_at", binding.get("reset_at").getAsString());
        }
        out.add("windows", windows);

        String planType = readString(quotaSnapshot, "planType");
        if (planType != null && !planType.isBlank()) {
            out.addProperty("level", planType);
        }
        if (readBoolean(quotaSnapshot, "stale")) {
            out.addProperty("stale", true);
        }
        return out;
    }

    static JsonObject unavailable(String message, String reasonCode) {
        JsonObject out = new JsonObject();
        out.addProperty("present", false);
        out.addProperty("unavailable", true);
        out.addProperty("provider", PROVIDER);
        out.addProperty("message", message != null && !message.isBlank() ? message : "Codex usage unavailable");
        if (reasonCode != null && !reasonCode.isBlank()) {
            out.addProperty("reason_code", reasonCode);
        }
        return out;
    }

    private static JsonObject toCapacityWindow(String id, JsonObject raw) {
        if (raw == null) {
            return null;
        }
        Double usedPercent = readDouble(raw, "usedPercent");
        if (usedPercent == null || !Double.isFinite(usedPercent)) {
            return null;
        }
        double clamped = Math.max(0.0, Math.min(100.0, usedPercent));
        JsonObject window = new JsonObject();
        window.addProperty("id", id);
        window.addProperty("used_pct", clamped);
        window.addProperty("period_type", id);

        Long resetsAtMs = readLong(raw, "resetsAt");
        if (resetsAtMs != null && resetsAtMs > 0) {
            window.addProperty("reset_at", Instant.ofEpochMilli(resetsAtMs).toString());
        }
        return window;
    }

    private static JsonObject pickBindingWindow(JsonArray windows) {
        JsonObject binding = windows.get(0).getAsJsonObject();
        double maxPct = binding.get("used_pct").getAsDouble();
        for (int i = 1; i < windows.size(); i++) {
            JsonObject candidate = windows.get(i).getAsJsonObject();
            double pct = candidate.get("used_pct").getAsDouble();
            if (pct > maxPct) {
                maxPct = pct;
                binding = candidate;
            }
        }
        return binding;
    }

    private static JsonObject readObject(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || !obj.get(key).isJsonObject()) {
            return null;
        }
        return obj.getAsJsonObject(key);
    }

    private static String readString(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(key);
        return el.isJsonPrimitive() ? el.getAsString() : null;
    }

    private static Double readDouble(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        try {
            return obj.get(key).getAsDouble();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Long readLong(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        try {
            return obj.get(key).getAsLong();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean readBoolean(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return false;
        }
        try {
            return obj.get(key).getAsBoolean();
        } catch (Exception ignored) {
            return false;
        }
    }
}
