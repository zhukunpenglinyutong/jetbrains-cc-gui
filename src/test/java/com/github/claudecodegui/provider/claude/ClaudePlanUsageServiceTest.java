package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
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
}
