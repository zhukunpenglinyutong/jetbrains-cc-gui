package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.TimeUnit;

/**
 * Grok plan-usage snapshot for the ContextBar.
 *
 * <p>The webview polls {@code get_grok_plan_usage}. A warm {@code grok agent stdio}
 * answers {@code _x.ai/billing} (one weekly or monthly credit window). When no chat
 * runtime is up, the daemon may start a short-lived stdio agent for that call only.
 */
public final class GrokPlanUsageService {

    private static final Logger LOG = Logger.getInstance(GrokPlanUsageService.class);

    /** Just under the webview poll so a regular tick re-reads, and extra windows share one RPC. */
    static final long FRESH_MS = 115_000L;
    /** Failures stay hidden and are retried soon, so a later login still fills the bar. */
    static final long NEGATIVE_MS = 20_000L;
    private static final long STALE_MAX_MS = 30 * 60_000L;
    private static final long RPC_TIMEOUT_SECONDS = 45L;

    private static volatile Snapshot cache;

    private GrokPlanUsageService() {
    }

    public static JsonObject resolvePlanUsagePayload(GrokSDKBridge bridge, String cwd) {
        synchronized (GrokPlanUsageService.class) {
            return resolveLocked(bridge, cwd, System.currentTimeMillis());
        }
    }

    static JsonObject resolveLocked(GrokSDKBridge bridge, String cwd, long nowMs) {
        Snapshot hit = cache;
        if (hit != null && nowMs - hit.atMs < hit.ttlMs) {
            return hit.payload.deepCopy();
        }
        if (bridge == null) {
            return unavailable("Grok bridge is not available");
        }
        try {
            JsonObject payload = bridge.getPlanUsage(cwd).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (payload == null || !payload.has("present")) {
                payload = unavailable("Grok usage unavailable");
            }
            boolean present = payload.get("present").getAsBoolean();
            cache = new Snapshot(nowMs, present ? FRESH_MS : NEGATIVE_MS, payload);
            return payload.deepCopy();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return unavailable("Grok usage interrupted");
        } catch (Exception e) {
            LOG.warn("Grok plan-usage resolve failed: " + e.getMessage());
            if (hit != null && hit.present && nowMs - hit.atMs < STALE_MAX_MS) {
                JsonObject copy = hit.payload.deepCopy();
                copy.addProperty("stale", true);
                return copy;
            }
            String message = e.getMessage() != null ? e.getMessage() : "Grok usage unavailable";
            return unavailable(message);
        }
    }

    static void resetCacheForTests() {
        cache = null;
    }

    private static JsonObject unavailable(String message) {
        JsonObject out = new JsonObject();
        out.addProperty("present", false);
        out.addProperty("unavailable", true);
        out.addProperty("provider", "grok");
        out.addProperty("source", "x.ai/billing");
        out.addProperty("message", message != null ? message : "Grok usage unavailable");
        return out;
    }

    private static final class Snapshot {
        final long atMs;
        final long ttlMs;
        final boolean present;
        final JsonObject payload;

        Snapshot(long atMs, long ttlMs, JsonObject payload) {
            this.atMs = atMs;
            this.ttlMs = ttlMs;
            this.present = payload.has("present") && payload.get("present").getAsBoolean();
            this.payload = payload.deepCopy();
        }
    }
}
