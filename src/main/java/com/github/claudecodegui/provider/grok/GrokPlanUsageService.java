package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/**
 * Grok plan-usage snapshot for the ContextBar.
 *
 * <p>The webview polls {@code get_grok_plan_usage}. A warm {@code grok agent stdio}
 * answers {@code _x.ai/billing} (one weekly or monthly credit window). When no chat
 * runtime is up, the daemon may start a short-lived stdio agent for that call only.
 * Without a running daemon the poll is {@code dormant}: the last reading ages out
 * normally and the failure ladder does not move.
 */
public final class GrokPlanUsageService {

    private static final Logger LOG = Logger.getInstance(GrokPlanUsageService.class);

    /** Just under the webview poll so a regular tick re-reads, and extra windows share one RPC. */
    static final long FRESH_MS = 115_000L;
    /** Failure backoff ladder: 20s -> 1m -> 5m -> 30m. */
    static final long[] BACKOFF_MS = new long[] { 20_000L, 60_000L, 300_000L, 1_800_000L };
    /** Failed polls may repeat the last present snapshot while its age is strictly under this. */
    static final long STALE_MAX_MS = 30 * 60_000L;
    private static final long RPC_TIMEOUT_SECONDS = 45L;

    private static volatile Snapshot cache;
    /** True while one window's RPC runs under the class lock. */
    private static volatile boolean inFlight = false;
    private static int failureStep = 0;
    private static long retryAfterMs = 0L;
    private static String lastFailureMessage = null;

    private GrokPlanUsageService() {
    }

    public static JsonObject resolvePlanUsagePayload(GrokSDKBridge bridge, String cwd) {
        long nowMs = System.currentTimeMillis();
        Snapshot hit = cache;
        // A fresh snapshot is shared without the class lock so a second window does not wait.
        JsonObject fresh = copyIfFresh(hit, nowMs);
        if (fresh != null) {
            return fresh;
        }
        // While another window's RPC runs, a young reading is served instead of waiting up to 45s for it.
        // {@code refreshing} tells the webview to ask again soon without counting a failure.
        if (inFlight && isYoungPresent(hit, nowMs)) {
            JsonObject copy = staleCopy(hit);
            copy.addProperty("refreshing", true);
            return copy;
        }
        synchronized (GrokPlanUsageService.class) {
            // The pre-lock timestamp is already in the past. A snapshot stored while
            // this thread waited would look like now < atMs and miss.
            return resolveLocked(bridge, cwd, System.currentTimeMillis(), System::currentTimeMillis);
        }
    }

    /** Test entry with a frozen clock: the RPC appears to finish at {@code nowMs}. */
    static JsonObject resolveLocked(GrokSDKBridge bridge, String cwd, long nowMs) {
        return resolveLocked(bridge, cwd, nowMs, () -> nowMs);
    }

    /**
     * @param nowMs time the poll started, used for the cache and the retry gate
     * @param clock read again after the RPC so a slow failure does not use up its own backoff
     */
    static JsonObject resolveLocked(GrokSDKBridge bridge, String cwd, long nowMs, LongSupplier clock) {
        Snapshot hit = cache;
        JsonObject fresh = copyIfFresh(hit, nowMs);
        if (fresh != null) {
            return fresh;
        }
        if (nowMs < retryAfterMs) {
            if (isYoungPresent(hit, nowMs)) {
                return staleCopy(hit);
            }
            return unavailable(lastFailureMessage != null ? lastFailureMessage : "Grok usage unavailable");
        }
        if (bridge == null) {
            return unavailable("Grok bridge is not available");
        }
        inFlight = true;
        try {
            JsonObject payload = bridge.getPlanUsage(cwd).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return applyPollResult(hit, nowMs, finishedAt(nowMs, clock), payload);
        } catch (InterruptedException e) {
            return onPollFailure(hit, finishedAt(nowMs, clock), "Grok usage interrupted", true);
        } catch (Exception e) {
            LOG.warn("Grok plan-usage resolve failed: " + e.getMessage());
            String message = e.getMessage() != null ? e.getMessage() : "Grok usage unavailable";
            return onPollFailure(hit, finishedAt(nowMs, clock), message, false);
        } finally {
            inFlight = false;
        }
    }

    /** A clock that went backwards must not end before the poll started. */
    private static long finishedAt(long startedMs, LongSupplier clock) {
        return Math.max(startedMs, clock.getAsLong());
    }

    private static JsonObject applyPollResult(Snapshot hit, long startedMs, long finishedMs, JsonObject payload) {
        if (hasTrueFlag(payload, "skipPolling")) {
            cache = null;
            failureStep = 0;
            retryAfterMs = 0L;
            lastFailureMessage = null;
            return payload.deepCopy();
        }
        if (hasTrueFlag(payload, "dormant")) {
            return dormantReply(hit, finishedMs, payload);
        }
        if (!hasTrueFlag(payload, "present")) {
            return onPollFailure(hit, finishedMs, failureMessage(payload), false);
        }
        failureStep = 0;
        retryAfterMs = 0L;
        lastFailureMessage = null;
        cache = new Snapshot(startedMs, FRESH_MS, payload);
        return payload.deepCopy();
    }

    /**
     * Nobody to ask (no daemon, or it is exiting). Not a failure, and it ends any failure
     * streak: the next session starts the ladder at 20s. A young reading is still shown, and
     * {@code dormant} lets the webview keep its normal cadence.
     */
    private static JsonObject dormantReply(Snapshot hit, long nowMs, JsonObject payload) {
        failureStep = 0;
        lastFailureMessage = null;
        JsonObject out = isYoungPresent(hit, nowMs) ? staleCopy(hit) : unavailable(failureMessage(payload));
        out.addProperty("dormant", true);
        return out;
    }

    /** {@code now >= atMs} and age strictly inside the snapshot ttl. A future {@code atMs} misses. */
    private static JsonObject copyIfFresh(Snapshot hit, long nowMs) {
        if (hit != null && nowMs >= hit.atMs && nowMs - hit.atMs < hit.ttlMs) {
            return hit.payload.deepCopy();
        }
        return null;
    }

    /** Present age in {@code [0, STALE_MAX_MS)}. A future {@code atMs} is not young. */
    private static boolean isYoungPresent(Snapshot hit, long nowMs) {
        return hit != null
                && hit.present
                && nowMs >= hit.atMs
                && nowMs - hit.atMs < STALE_MAX_MS;
    }

    private static JsonObject staleCopy(Snapshot hit) {
        JsonObject copy = hit.payload.deepCopy();
        copy.addProperty("stale", true);
        return copy;
    }

    /**
     * Arm the current ladder and keep the stored snapshot.
     * {@code stale} is set only on the returned copy, and only while that snapshot is young.
     */
    private static JsonObject onPollFailure(
            Snapshot hit,
            long nowMs,
            String message,
            boolean interrupted
    ) {
        long ttl = BACKOFF_MS[failureStep];
        failureStep = Math.min(failureStep + 1, BACKOFF_MS.length - 1);
        retryAfterMs = nowMs + ttl;
        String resolved = message != null ? message : "Grok usage unavailable";
        lastFailureMessage = resolved;
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
        if (isYoungPresent(hit, nowMs)) {
            return staleCopy(hit);
        }
        return unavailable(resolved);
    }

    private static boolean hasTrueFlag(JsonObject payload, String key) {
        return payload != null
                && payload.has(key)
                && payload.get(key).isJsonPrimitive()
                && payload.get(key).getAsJsonPrimitive().isBoolean()
                && payload.get(key).getAsBoolean();
    }

    private static String failureMessage(JsonObject payload) {
        if (payload != null
                && payload.has("message")
                && payload.get("message").isJsonPrimitive()) {
            return payload.get("message").getAsString();
        }
        return "Grok usage unavailable";
    }

    static void resetCacheForTests() {
        cache = null;
        inFlight = false;
        failureStep = 0;
        retryAfterMs = 0L;
        lastFailureMessage = null;
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
