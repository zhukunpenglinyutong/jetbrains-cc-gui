package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClaudePlanUsageServiceTest {

    /** resetsAt is epoch SECONDS in the CLI rate_limit_info schema. */
    private static JsonObject info(double utilization, long resetsAtSec, String status) {
        JsonObject o = new JsonObject();
        o.addProperty("utilization", utilization);
        o.addProperty("resetsAt", resetsAtSec);
        if (status != null) {
            o.addProperty("status", status);
        }
        return o;
    }

    private static long nowSec() {
        return System.currentTimeMillis() / 1000L;
    }

    @Test
    public void buildCapacityPayload_fractionUtilization_mapsToPercentWith5hWindow() {
        long resetsAt = nowSec() + 3L * 60 * 60; // ~3h out → 5h bucket
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(0.42, resetsAt, "allowed_warning"));

        assertEquals(42.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("claude", payload.get("provider").getAsString());
        assertEquals("sdk-rate-limit", payload.get("source").getAsString());
        assertTrue(payload.get("present").getAsBoolean());
        assertEquals("5h", payload.get("period_type").getAsString());
        assertEquals("allowed_warning", payload.get("rate_limit_status").getAsString());
        assertTrue(payload.has("reset_at"));

        JsonObject window = payload.getAsJsonArray("windows").get(0).getAsJsonObject();
        assertEquals("5h", window.get("id").getAsString());
        assertEquals(42.0, window.get("used_pct").getAsDouble(), 0.01);
        assertEquals("5h", window.get("period_type").getAsString());
    }

    @Test
    public void buildCapacityPayload_epochSecondsResetAt_convertsToMillis() {
        long resetsAtSec = nowSec() + 2L * 60 * 60; // 2h out
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(0.1, resetsAtSec, null));

        String resetAt = payload.get("reset_at").getAsString();
        long parsedMs = java.time.Instant.parse(resetAt).toEpochMilli();
        assertEquals(resetsAtSec * 1000L, parsedMs);
        // 2h out must classify as the 5h window — with the old millis misread
        // this landed in 1970 and misclassified everything.
        assertEquals("5h", payload.get("period_type").getAsString());
    }

    @Test
    public void buildCapacityPayload_overLimitFraction_clampsToHundred() {
        // utilization 1.3 = 130% used (over capacity) — must surface as ~100%,
        // not as a tiny "1.3%" reading.
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(1.3, nowSec() + 3600, null));
        assertEquals(100.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void buildCapacityPayload_percentUtilizationAboveTen_treatedAsPercent() {
        long resetsAt = nowSec() + 5L * 24 * 60 * 60; // ~5d → 7d bucket
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(87.0, resetsAt, "rejected"));

        assertEquals(87.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("7d", payload.get("period_type").getAsString());
        assertEquals("rejected", payload.get("rate_limit_status").getAsString());
    }

    @Test
    public void buildCapacityPayload_rateLimitTypeWinsOverDeltaHeuristic() {
        // A seven_day window whose reset happens to be <6h out must still be 7d.
        JsonObject o = info(0.5, nowSec() + 2L * 60 * 60, null);
        o.addProperty("rateLimitType", "seven_day");
        assertEquals("7d", ClaudePlanUsageService.buildCapacityPayload(o).get("period_type").getAsString());

        JsonObject sonnet = info(0.5, nowSec() + 2L * 60 * 60, null);
        sonnet.addProperty("rateLimitType", "seven_day_sonnet");
        assertEquals("7d", ClaudePlanUsageService.buildCapacityPayload(sonnet).get("period_type").getAsString());

        JsonObject fiveHour = info(0.5, nowSec() + 5L * 24 * 60 * 60, null);
        fiveHour.addProperty("rateLimitType", "five_hour");
        assertEquals("5h", ClaudePlanUsageService.buildCapacityPayload(fiveHour).get("period_type").getAsString());
    }

    @Test
    public void buildCapacityPayload_missingUtilization_returnsNull() {
        JsonObject noUtil = new JsonObject();
        noUtil.addProperty("resetsAt", nowSec() + 1L);
        assertNull(ClaudePlanUsageService.buildCapacityPayload(noUtil));
    }

    @Test
    public void clampPct_boundsZeroToHundred() {
        assertEquals(0.0, ClaudePlanUsageService.clampPct(-5), 0.001);
        assertEquals(100.0, ClaudePlanUsageService.clampPct(144), 0.001);
        assertEquals(50.0, ClaudePlanUsageService.clampPct(50), 0.001);
    }

    @Test
    public void periodTypeFromResetMs_classifies5hAnd7d() {
        long now = System.currentTimeMillis();
        assertEquals("5h", ClaudePlanUsageService.periodTypeFromResetMs(now + 2L * 60 * 60 * 1000));
        assertEquals("5h", ClaudePlanUsageService.periodTypeFromResetMs(now + 6L * 60 * 60 * 1000));
        assertEquals("7d", ClaudePlanUsageService.periodTypeFromResetMs(now + 2L * 24 * 60 * 60 * 1000));
    }

    @Test
    public void parseZaiQuota_maps5h7dWindowsAndLevel() {
        JsonObject body = JsonParser.parseString("""
                {"code":200,"success":true,"data":{
                  "level":"max",
                  "limits":[
                    {"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":13,"nextResetTime":1786624965401},
                    {"type":"CREDIT_LIMIT","unit":6,"number":1,"percentage":2,"nextResetTime":1787155353998}
                  ]
                }}
                """).getAsJsonObject();
        JsonObject payload = ClaudePlanUsageService.parseZaiQuota(body);

        assertEquals("claude", payload.get("provider").getAsString());
        assertEquals("zai-quota-limit", payload.get("source").getAsString());
        assertTrue(payload.get("present").getAsBoolean());
        assertEquals(13.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("5h", payload.get("period_type").getAsString());
        assertEquals("max", payload.get("level").getAsString());

        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(2, windows.size());
        JsonObject w0 = windows.get(0).getAsJsonObject();
        assertEquals("5h", w0.get("id").getAsString());
        assertEquals(13.0, w0.get("used_pct").getAsDouble(), 0.01);
        assertEquals("7d", windows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(2.0, windows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseZaiQuota_timeLimitMapsToMonthly() {
        JsonObject body = JsonParser.parseString("""
                {"data":{"level":"pro","limits":[
                  {"type":"TIME_LIMIT","unit":4,"number":1,"percentage":55}
                ]}}
                """).getAsJsonObject();
        JsonObject payload = ClaudePlanUsageService.parseZaiQuota(body);
        assertEquals("monthly", payload.getAsJsonArray("windows").get(0).getAsJsonObject().get("id").getAsString());
        assertEquals("pro", payload.get("level").getAsString());
    }

    @Test
    public void parseZaiQuota_emptyLimitsReturnsNull() {
        JsonObject body = JsonParser.parseString("{\"data\":{\"limits\":[]}}").getAsJsonObject();
        assertNull(ClaudePlanUsageService.parseZaiQuota(body));
    }

    @Test
    public void parseZaiQuota_creditLimitUnitDays_mapsTo7d() {
        JsonObject body = JsonParser.parseString("""
                {"data":{"limits":[
                  {"type":"CREDIT_LIMIT","unit":4,"number":7,"percentage":41}
                ]}}
                """).getAsJsonObject();
        JsonObject payload = ClaudePlanUsageService.parseZaiQuota(body);
        assertEquals("7d", payload.getAsJsonArray("windows").get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(41.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void isZaiBackend_matchesHostOnly() {
        assertTrue(ClaudePlanUsageService.isZaiBackend(settingsWithBase("https://api.z.ai/api/anthropic")));
        assertTrue(ClaudePlanUsageService.isZaiBackend(settingsWithBase("https://z.ai/api/anthropic")));
        assertFalse(ClaudePlanUsageService.isZaiBackend(settingsWithBase("https://api.anthropic.com")));
        // Look-alike hosts must not trigger the z.ai probe
        assertFalse(ClaudePlanUsageService.isZaiBackend(settingsWithBase("https://quiz.ai/api/anthropic")));
        assertFalse(ClaudePlanUsageService.isZaiBackend(settingsWithBase("https://buzz.ai/api")));
        // z.ai appearing only in the path is not a z.ai host
        assertFalse(ClaudePlanUsageService.isZaiBackend(settingsWithBase("https://gateway.example.com/z.ai/proxy")));
        // Malformed base URL → not z.ai, never throws
        assertFalse(ClaudePlanUsageService.isZaiBackend(settingsWithBase("not a url")));
    }

    @Test
    public void monitorUrl_derivesOriginAndPath() {
        assertEquals("https://api.z.ai/api/monitor/usage/quota/limit",
                ClaudePlanUsageService.monitorUrl("https://api.z.ai/api/anthropic"));
    }

    @Test
    public void monitorUrl_keepsCustomPort() {
        assertEquals("http://localhost:8080/api/monitor/usage/quota/limit",
                ClaudePlanUsageService.monitorUrl("http://localhost:8080/api/anthropic"));
    }

    @Test
    public void monitorUrl_rejectsPlainHttpExceptLoopback() {
        // Bearer tokens must not travel over plaintext to a remote host
        assertNull(ClaudePlanUsageService.monitorUrl("http://api.z.ai/api/anthropic"));
        assertNull(ClaudePlanUsageService.monitorUrl("http://z.ai/api/anthropic"));
        // Loopback proxies (local dev / tests) may use plain HTTP
        assertEquals("http://127.0.0.1:9000/api/monitor/usage/quota/limit",
                ClaudePlanUsageService.monitorUrl("http://127.0.0.1:9000/api/anthropic"));
        assertEquals("http://localhost:8080/api/monitor/usage/quota/limit",
                ClaudePlanUsageService.monitorUrl("http://localhost:8080/api/anthropic"));
    }

    @Test
    public void parseZaiQuota_duplicatePeriodsMergeKeepingWorst() {
        JsonObject body = JsonParser.parseString("""
                {"data":{"limits":[
                  {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":10,"nextResetTime":1786624965401},
                  {"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":20,"nextResetTime":1786624965401}
                ]}}
                """).getAsJsonObject();
        JsonObject payload = ClaudePlanUsageService.parseZaiQuota(body);

        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(1, windows.size());
        JsonObject w = windows.get(0).getAsJsonObject();
        assertEquals("5h", w.get("id").getAsString());
        assertEquals(20.0, w.get("used_pct").getAsDouble(), 0.01);
        assertEquals(20.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    // ===== probe pipeline (transport injected) =====

    @org.junit.After
    public void tearDown() {
        ClaudePlanUsageService.setZaiTransportForTests(null);
        ClaudePlanUsageService.resetZaiCacheForTests();
    }

    @Test
    public void resolveViaZaiMonitor_sendsBearerTokenToMonitorUrl() {
        String[] seen = new String[2];
        ClaudePlanUsageService.setZaiTransportForTests((url, token) -> {
            seen[0] = url;
            seen[1] = token;
            return zaiBody(42);
        });

        JsonObject payload = ClaudePlanUsageService.resolveViaZaiMonitor(
                settingsWithBaseAndToken("https://api.z.ai/api/anthropic", "glm-secret"), 1000L);

        assertEquals("https://api.z.ai/api/monitor/usage/quota/limit", seen[0]);
        assertEquals("glm-secret", seen[1]);
        assertEquals(42.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void resolveViaZaiMonitor_fallsBackToApiKeyWhenAuthTokenMissing() {
        String[] seen = new String[1];
        ClaudePlanUsageService.setZaiTransportForTests((url, token) -> {
            seen[0] = token;
            return zaiBody(1);
        });

        JsonObject settings = settingsWithBase("https://api.z.ai/api/anthropic");
        settings.getAsJsonObject("env").addProperty("ANTHROPIC_API_KEY", "sk-fallback");
        ClaudePlanUsageService.resolveViaZaiMonitor(settings, 1000L);

        assertEquals("sk-fallback", seen[0]);
    }

    @Test
    public void resolveViaZaiMonitor_cacheTtlEnforced() {
        int[] calls = {0};
        ClaudePlanUsageService.setZaiTransportForTests((url, token) -> {
            calls[0]++;
            return zaiBody(10);
        });
        JsonObject settings = settingsWithBaseAndToken("https://api.z.ai/api/anthropic", "t");
        long t0 = 1_000_000L;

        ClaudePlanUsageService.resolveViaZaiMonitor(settings, t0);
        assertEquals(1, calls[0]);
        // Within TTL → served from cache, no second probe
        ClaudePlanUsageService.resolveViaZaiMonitor(settings, t0 + ClaudePlanUsageService.ZAI_CACHE_TTL_MS - 1);
        assertEquals(1, calls[0]);
        // TTL expired → probes again
        ClaudePlanUsageService.resolveViaZaiMonitor(settings, t0 + ClaudePlanUsageService.ZAI_CACHE_TTL_MS + 1);
        assertEquals(2, calls[0]);
    }

    @Test
    public void resolveViaZaiMonitor_cacheKeyedByUrlAndToken() {
        int[] calls = {0};
        ClaudePlanUsageService.setZaiTransportForTests((url, token) -> {
            calls[0]++;
            return zaiBody(10);
        });
        long t0 = 1_000_000L;

        ClaudePlanUsageService.resolveViaZaiMonitor(
                settingsWithBaseAndToken("https://api.z.ai/api/anthropic", "account-a"), t0);
        assertEquals(1, calls[0]);
        // Same URL but a different token (account switch) must not reuse the cache
        ClaudePlanUsageService.resolveViaZaiMonitor(
                settingsWithBaseAndToken("https://api.z.ai/api/anthropic", "account-b"), t0 + 1);
        assertEquals(2, calls[0]);
    }

    @Test
    public void resolveViaZaiMonitor_staleFallbackOnProbeFailure() {
        boolean[] fail = {false};
        ClaudePlanUsageService.setZaiTransportForTests((url, token) -> {
            if (fail[0]) {
                throw new IllegalStateException("boom");
            }
            return zaiBody(33);
        });
        JsonObject settings = settingsWithBaseAndToken("https://api.z.ai/api/anthropic", "t");
        long t0 = 1_000_000L;

        ClaudePlanUsageService.resolveViaZaiMonitor(settings, t0);

        fail[0] = true;
        // Probe fails with an expired-but-recent cache → stale payload
        JsonObject stale = ClaudePlanUsageService.resolveViaZaiMonitor(
                settings, t0 + ClaudePlanUsageService.ZAI_CACHE_TTL_MS + 1);
        assertEquals(33.0, stale.get("capacity_pct").getAsDouble(), 0.01);
        assertTrue(stale.get("stale").getAsBoolean());

        // Cache older than the stale cap → give up (null → caller falls back)
        assertNull(ClaudePlanUsageService.resolveViaZaiMonitor(
                settings, t0 + ClaudePlanUsageService.ZAI_STALE_MAX_MS + 1));
    }

    private static JsonObject zaiBody(double pct) {
        return JsonParser.parseString(
                "{\"data\":{\"level\":\"max\",\"limits\":["
                        + "{\"type\":\"CREDIT_LIMIT\",\"unit\":3,\"number\":5,\"percentage\":" + pct
                        + ",\"nextResetTime\":1786624965401}]}}").getAsJsonObject();
    }

    private static JsonObject settingsWithBaseAndToken(String base, String token) {
        JsonObject settings = settingsWithBase(base);
        settings.getAsJsonObject("env").addProperty("ANTHROPIC_AUTH_TOKEN", token);
        return settings;
    }

    private static JsonObject settingsWithBase(String base) {
        JsonObject settings = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_BASE_URL", base);
        settings.add("env", env);
        return settings;
    }
}
