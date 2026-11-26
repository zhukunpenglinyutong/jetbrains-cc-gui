package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.settings.CodexProviderManager;
import com.github.claudecodegui.settings.SessionSupplierCatalog;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.time.Instant;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodexPlanUsageServiceTest {

    @Test
    public void mapsDualWindowQuotaSnapshotWithBindingWorstWindow() {
        JsonObject quota = new JsonObject();
        quota.addProperty("status", "ok");
        quota.addProperty("source", "wham_usage");
        quota.addProperty("planType", "plus");

        JsonObject fiveHour = new JsonObject();
        fiveHour.addProperty("usedPercent", 31.0);
        fiveHour.addProperty("resetsAt", 1735401600000L);

        JsonObject weekly = new JsonObject();
        weekly.addProperty("usedPercent", 58.0);
        weekly.addProperty("resetsAt", 1735920000000L);

        JsonObject windows = new JsonObject();
        windows.add("fiveHour", fiveHour);
        windows.add("weekly", weekly);
        quota.add("windows", windows);

        JsonObject payload = CodexPlanUsageService.toCapacityPayload(quota);

        assertTrue(payload.get("present").getAsBoolean());
        assertEquals("codex", payload.get("provider").getAsString());
        assertEquals("wham_usage", payload.get("source").getAsString());
        assertEquals("plus", payload.get("level").getAsString());
        assertEquals(58.0, payload.get("capacity_pct").getAsDouble(), 0.001);
        assertEquals("7d", payload.get("period_type").getAsString());
        assertEquals(Instant.ofEpochMilli(1735920000000L).toString(), payload.get("reset_at").getAsString());

        JsonArray outWindows = payload.getAsJsonArray("windows");
        assertEquals(2, outWindows.size());
        assertEquals("5h", outWindows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(31.0, outWindows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.001);
        assertEquals("7d", outWindows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(58.0, outWindows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.001);
    }

    @Test
    public void mapsWeeklyOnlyProSnapshotIncludingZeroPercentUsage() {
        JsonObject quota = new JsonObject();
        quota.addProperty("status", "ok");
        quota.addProperty("source", "session_event");
        quota.addProperty("planType", "pro");
        quota.addProperty("stale", true);

        JsonObject fiveHour = new JsonObject();
        fiveHour.add("usedPercent", JsonNull.INSTANCE);
        fiveHour.add("resetsAt", JsonNull.INSTANCE);

        JsonObject weekly = new JsonObject();
        weekly.addProperty("usedPercent", 0.0);
        weekly.addProperty("resetsAt", 1796276809000L);

        JsonObject windows = new JsonObject();
        windows.add("fiveHour", fiveHour);
        windows.add("weekly", weekly);
        quota.add("windows", windows);

        JsonObject payload = CodexPlanUsageService.toCapacityPayload(quota);

        assertTrue(payload.get("present").getAsBoolean());
        assertTrue(payload.get("stale").getAsBoolean());
        assertEquals("pro", payload.get("level").getAsString());
        assertEquals(0.0, payload.get("capacity_pct").getAsDouble(), 0.001);
        assertEquals("7d", payload.get("period_type").getAsString());
        assertEquals(Instant.ofEpochMilli(1796276809000L).toString(), payload.get("reset_at").getAsString());

        JsonArray outWindows = payload.getAsJsonArray("windows");
        assertEquals(1, outWindows.size());
        assertEquals("7d", outWindows.get(0).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void mapsApiKeyModeUnavailablePayloadAndPreservesReasonCode() {
        JsonObject quota = new JsonObject();
        quota.addProperty("status", "unavailable");
        quota.addProperty("error", "API key mode has no subscription quota");
        quota.addProperty("reasonCode", "api_key_mode");

        JsonObject payload = CodexPlanUsageService.toCapacityPayload(quota);

        assertFalse(payload.get("present").getAsBoolean());
        assertTrue(payload.get("unavailable").getAsBoolean());
        assertEquals("codex", payload.get("provider").getAsString());
        assertEquals("api_key_mode", payload.get("reason_code").getAsString());
        assertEquals("API key mode has no subscription quota", payload.get("message").getAsString());
    }

    @Test
    public void managedSupplierBindingReturnsApiKeyModeWithoutCallingQuotaService() throws Exception {
        JsonObject payload = CodexPlanUsageService
                .resolvePlanUsagePayloadAsync(null, "custom-relay-provider-id")
                .get(2, TimeUnit.SECONDS);

        assertFalse(payload.get("present").getAsBoolean());
        assertEquals("api_key_mode", payload.get("reason_code").getAsString());
    }

    @Test
    public void classifiesManagedVsCliLoginSupplierBindings() {
        assertFalse(CodexPlanUsageService.isManagedSupplierBinding(null));
        assertFalse(CodexPlanUsageService.isManagedSupplierBinding(""));
        assertFalse(CodexPlanUsageService.isManagedSupplierBinding(CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID));
        assertFalse(CodexPlanUsageService.isManagedSupplierBinding(SessionSupplierCatalog.UNAVAILABLE));
        assertTrue(CodexPlanUsageService.isManagedSupplierBinding("8d230ed7-c47a-41a3-85e6-627ec2e92a00"));
    }

    @Test
    public void clampsOutOfRangePercentAndOmitsMissingResetAt() {
        JsonObject quota = new JsonObject();
        quota.addProperty("status", "ok");
        quota.addProperty("source", "wham_usage");

        JsonObject fiveHour = new JsonObject();
        fiveHour.addProperty("usedPercent", 140.0);
        fiveHour.add("resetsAt", JsonNull.INSTANCE);

        JsonObject weekly = new JsonObject();
        weekly.addProperty("usedPercent", -5.0);
        weekly.addProperty("resetsAt", 0L);

        JsonObject windows = new JsonObject();
        windows.add("fiveHour", fiveHour);
        windows.add("weekly", weekly);
        quota.add("windows", windows);

        JsonObject payload = CodexPlanUsageService.toCapacityPayload(quota);

        assertTrue(payload.get("present").getAsBoolean());
        assertEquals(100.0, payload.get("capacity_pct").getAsDouble(), 0.001);
        assertFalse(payload.has("reset_at"));
        JsonArray outWindows = payload.getAsJsonArray("windows");
        assertEquals(100.0, outWindows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.001);
        assertFalse(outWindows.get(0).getAsJsonObject().has("reset_at"));
        assertEquals(0.0, outWindows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.001);
        assertFalse(outWindows.get(1).getAsJsonObject().has("reset_at"));
    }

    @Test
    public void returnsUnavailableWhenNullOrNoWindowHasPercent() {
        assertFalse(CodexPlanUsageService.toCapacityPayload(null).get("present").getAsBoolean());

        JsonObject quota = new JsonObject();
        quota.addProperty("status", "ok");
        JsonObject emptyWindow = new JsonObject();
        emptyWindow.add("usedPercent", JsonNull.INSTANCE);
        JsonObject windows = new JsonObject();
        windows.add("fiveHour", emptyWindow);
        windows.add("weekly", emptyWindow.deepCopy());
        quota.add("windows", windows);

        JsonObject payload = CodexPlanUsageService.toCapacityPayload(quota);
        assertFalse(payload.get("present").getAsBoolean());
        assertTrue(payload.get("unavailable").getAsBoolean());
    }
}
