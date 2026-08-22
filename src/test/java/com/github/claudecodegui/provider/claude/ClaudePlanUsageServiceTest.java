package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClaudePlanUsageServiceTest {

    private static JsonObject info(double utilization, long resetsAtMs, String status) {
        JsonObject o = new JsonObject();
        o.addProperty("utilization", utilization);
        o.addProperty("resetsAt", resetsAtMs);
        if (status != null) {
            o.addProperty("status", status);
        }
        return o;
    }

    @Test
    public void buildCapacityPayload_fractionUtilization_mapsToPercentWith5hWindow() {
        long resetsAt = System.currentTimeMillis() + 3L * 60 * 60 * 1000; // ~3h out → 5h bucket
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
    public void buildCapacityPayload_percentUtilizationAboveOne_treatedAsPercent() {
        long resetsAt = System.currentTimeMillis() + 5L * 24 * 60 * 60 * 1000; // ~5d → 7d bucket
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(87.0, resetsAt, "rejected"));

        assertEquals(87.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("7d", payload.get("period_type").getAsString());
        assertEquals("rejected", payload.get("rate_limit_status").getAsString());
    }

    @Test
    public void buildCapacityPayload_missingUtilization_returnsNull() {
        JsonObject noUtil = new JsonObject();
        noUtil.addProperty("resetsAt", System.currentTimeMillis() + 1000L);
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

    private static JsonObject settingsWithBase(String base) {
        JsonObject settings = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_BASE_URL", base);
        settings.add("env", env);
        return settings;
    }
}
