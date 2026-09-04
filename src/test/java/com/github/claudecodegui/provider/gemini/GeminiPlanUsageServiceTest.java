package com.github.claudecodegui.provider.gemini;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Contract tests for the zero-cost {@code agy -p "/usage"} quota probe (Story 1.8).
 *
 * <p>Fixtures are live-captured shapes (spec: external-cli-behaviors.md#Quota-payload):
 * <ul>
 *   <li><b>FULL</b> — both billing groups with weekly + 5h buckets (agy 1.1.22
 *       capture, 2026-08-31, as documented in the story).</li>
 *   <li><b>WEEKLY_ONLY</b> — verbatim agy 1.1.26 capture, 2026-09-04: the CLI
 *       currently reports ONLY weekly buckets; the 5h bucket appears when
 *       applicable. The parser must tolerate absent buckets, never fabricate.</li>
 * </ul>
 *
 * <p>AC3 (zero-cost probe) is encoded directly on the fixtures: {@code usage}
 * all-zero, {@code num_turns:0}, empty {@code conversation_id} — the probe is
 * structurally not a model turn, and the service must read ONLY
 * {@code command.data.groups}, never the human-readable {@code response} text.
 */
public class GeminiPlanUsageServiceTest {

    // ===== live-shaped fixtures =====

    /** Full shape: two groups × {weekly, 5h} buckets (agy 1.1.22, 2026-08-31). */
    private static final String FULL_USAGE_PAYLOAD = """
            {
              "conversation_id": "",
              "status": "SUCCESS",
              "response": "Gemini Models\\tWeekly Limit Remaining\\t76%\\t2026-09-10T20:06:55Z\\nClaude and GPT models\\tWeekly Limit Remaining\\t100%\\t2026-09-11T16:38:34Z\\n",
              "duration_seconds": 0,
              "num_turns": 0,
              "usage": {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0,
                         "cache_read_tokens": 0, "total_tokens": 0},
              "command": {"name": "usage", "data": {"description": "Within each group, models share a weekly limit.",
                "groups": [
                  {"name": "Gemini Models", "description": "Models within this group: Gemini Flash, Gemini Pro",
                   "buckets": [
                     {"id": "gemini-weekly", "name": "Weekly Limit Remaining",
                      "description": "You have used some of your weekly limit, it will fully refresh in 6 days, 3 hours.",
                      "window": "weekly", "remaining_fraction": 0.7616943717002869,
                      "reset_time": "2026-09-10T20:06:55Z"},
                     {"id": "gemini-5h", "name": "5h Limit Remaining",
                      "window": "5h", "remaining_fraction": 0.42,
                      "reset_time": "2026-09-08T18:15:00Z"}
                   ]},
                  {"name": "Claude and GPT models", "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
                   "buckets": [
                     {"id": "3p-weekly", "name": "Weekly Limit Remaining",
                      "window": "weekly", "remaining_fraction": 1,
                      "reset_time": "2026-09-11T16:38:34Z"},
                     {"id": "3p-5h", "name": "5h Limit Remaining",
                      "window": "5h", "remaining_fraction": 0.88,
                      "reset_time": "2026-09-08T19:40:00Z"}
                   ]}
                ]}}
            }
            """;

    /** Verbatim live capture: agy 1.1.26, 2026-09-04 — weekly buckets ONLY, no 5h bucket. */
    private static final String WEEKLY_ONLY_USAGE_PAYLOAD = """
            {"conversation_id":"","status":"SUCCESS",
             "response":"Gemini Models\\tWeekly Limit Remaining\\t76%\\t2026-09-10T20:06:55Z\\nClaude and GPT models\\tWeekly Limit Remaining\\t100%\\t2026-09-11T16:38:34Z\\n",
             "duration_seconds":0,"num_turns":0,
             "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},
             "command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. Your weekly limit is tied directly to your individual tier.",
               "groups":[
                 {"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro",
                  "buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining",
                              "description":"You have used some of your weekly limit, it will fully refresh in 6 days, 3 hours.",
                              "window":"weekly","remaining_fraction":0.7616943717002869,
                              "reset_time":"2026-09-10T20:06:55Z"}]},
                 {"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
                  "buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining",
                              "window":"weekly","remaining_fraction":1,
                              "reset_time":"2026-09-11T16:38:34Z"}]}
               ]}}}
            """;

    /** Depletion variant of the full shape: the 5h Gemini bucket fully consumed. */
    private static final String DEPLETED_USAGE_PAYLOAD = FULL_USAGE_PAYLOAD
            .replace("\"remaining_fraction\": 0.42", "\"remaining_fraction\": 0");

    /** Old-CLI hazard shape: SUCCESS, response text present, NO command object. */
    private static final String OLD_CLI_PAYLOAD = """
            {"conversation_id":"", "status":"SUCCESS",
             "response":"I could not find any usage. Did you mean...?",
             "duration_seconds":3.1, "num_turns":1,
             "usage":{"input_tokens":412,"output_tokens":58,"thinking_tokens":0,
                       "cache_read_tokens":0,"total_tokens":470}}
            """;

    /** /clear-style live behavior: actionable ERROR text while exit code is 0. */
    private static final String ERROR_STATUS_PAYLOAD = """
            {"conversation_id":"", "status":"ERROR",
             "response":"Unknown command: /usage",
             "duration_seconds":0, "num_turns":0,
             "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,
                       "cache_read_tokens":0,"total_tokens":0}}
            """;

    private static JsonObject payload(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static JsonObject findWindow(JsonObject mapped, String id) {
        for (var el : mapped.getAsJsonArray("windows")) {
            JsonObject w = el.getAsJsonObject();
            if (id.equals(w.get("id").getAsString())) {
                return w;
            }
        }
        return null;
    }

    @After
    public void tearDown() {
        GeminiPlanUsageService.setAgyTransportForTests(null);
        GeminiPlanUsageService.setCliVersionForTests(null);
        GeminiPlanUsageService.resetCacheForTests();
    }

    // ===== family + bucket mapping (AC1, AC2, NFR9) =====

    @Test
    public void parseUsagePayload_geminiSlug_mapsGeminiFamilyWindows() {
        JsonObject mapped = GeminiPlanUsageService.parseUsagePayload(
                payload(FULL_USAGE_PAYLOAD), "gemini-3.7-flash-high");

        assertTrue(mapped.get("present").getAsBoolean());
        assertEquals("gemini", mapped.get("provider").getAsString());
        // gemini-5h is the binding window: 42% remaining → 58% used
        assertEquals(58.0, mapped.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("5h", mapped.get("period_type").getAsString());

        JsonObject w5h = findWindow(mapped, "gemini-5h");
        assertNotNull(w5h);
        assertEquals(58.0, w5h.get("used_pct").getAsDouble(), 0.01);
        assertEquals("5h", w5h.get("period_type").getAsString());
        assertEquals("2026-09-08T18:15:00Z", w5h.get("reset_at").getAsString());

        JsonObject weekly = findWindow(mapped, "gemini-weekly");
        assertNotNull(weekly);
        assertEquals(23.83, weekly.get("used_pct").getAsDouble(), 0.01);
        assertEquals("weekly", weekly.get("period_type").getAsString());
        assertEquals("2026-09-10T20:06:55Z", weekly.get("reset_at").getAsString());
        // The 3P family's numbers must NOT leak into the gemini view
        assertNull(findWindow(mapped, "3p-5h"));
        assertNull(findWindow(mapped, "3p-weekly"));
    }

    @Test
    public void parseUsagePayload_thirdPartySlugs_maps3pFamilyWindows() {
        for (String slug : new String[]{"claude-sonnet-4-6", "gpt-oss-120b-medium"}) {
            JsonObject mapped = GeminiPlanUsageService.parseUsagePayload(
                    payload(FULL_USAGE_PAYLOAD), slug);

            assertEquals("claude/gpt slugs select the third-party billing family: " + slug,
                    12.0, mapped.get("capacity_pct").getAsDouble(), 0.01);
            assertNotNull(findWindow(mapped, "3p-5h"));
            assertNotNull(findWindow(mapped, "3p-weekly"));
            assertNull(findWindow(mapped, "gemini-5h"));
            assertNull(findWindow(mapped, "gemini-weekly"));
        }
    }

    @Test
    public void parseUsagePayload_unknownAutoOrNullModel_defaultsToGeminiFamily() {
        // 'auto' is gemini's default selection state (Story 1.4) and the CLI's own
        // default routes to a Gemini model — unknown must never show 3P numbers.
        for (String slug : new String[]{null, "", "auto", "mystery-model"}) {
            JsonObject mapped = GeminiPlanUsageService.parseUsagePayload(
                    payload(FULL_USAGE_PAYLOAD), slug);
            assertNotNull("a default family must always resolve for: " + slug, mapped);
            assertNotNull(findWindow(mapped, "gemini-5h"));
            assertNull(findWindow(mapped, "3p-5h"));
        }
    }

    @Test
    public void parseUsagePayload_weeklyOnlyLiveShape_toleratesAbsent5hBucket() {
        JsonObject mapped = GeminiPlanUsageService.parseUsagePayload(
                payload(WEEKLY_ONLY_USAGE_PAYLOAD), "gemini-3.7-flash-high");

        assertEquals(1, mapped.getAsJsonArray("windows").size());
        JsonObject weekly = findWindow(mapped, "gemini-weekly");
        assertNotNull(weekly);
        assertEquals(23.83, weekly.get("used_pct").getAsDouble(), 0.01);
        assertEquals("weekly", weekly.get("period_type").getAsString());
        // No 5h bucket reported → capacity falls back to the reported window,
        // never a fabricated 0%/100% for the missing window.
        assertEquals(23.83, mapped.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("weekly", mapped.get("period_type").getAsString());
    }

    @Test
    public void parseUsagePayload_usedPctMath_clampsRemainingFractionBounds() {
        // remaining 1 → 0% used; remaining 0 → 100% used (depletion visible, AC6)
        JsonObject mapped = GeminiPlanUsageService.parseUsagePayload(
                payload(FULL_USAGE_PAYLOAD), "claude-sonnet-4-6");
        assertEquals(0.0, findWindow(mapped, "3p-weekly").get("used_pct").getAsDouble(), 0.001);
        assertEquals(12.0, findWindow(mapped, "3p-5h").get("used_pct").getAsDouble(), 0.001);

        JsonObject depleted = GeminiPlanUsageService.parseUsagePayload(
                payload(DEPLETED_USAGE_PAYLOAD), "gemini-3.7-flash-high");
        assertEquals(100.0, findWindow(depleted, "gemini-5h").get("used_pct").getAsDouble(), 0.001);
    }

    @Test
    public void parseUsagePayload_ignoresResponseText_dataComesOnlyFromCommandObject() {
        // The human-readable `response` line claims "5%" — a response-text parser
        // would show 95% used. Only command.data.groups is authoritative.
        String decoy = WEEKLY_ONLY_USAGE_PAYLOAD
                .replace("Weekly Limit Remaining\\t76%", "Weekly Limit Remaining\\t5%");
        JsonObject mapped = GeminiPlanUsageService.parseUsagePayload(
                payload(decoy), "gemini-3.7-flash-high");
        assertEquals(23.83, mapped.get("capacity_pct").getAsDouble(), 0.01);
    }

    // ===== AC3: the probe is structurally not a model turn =====

    @Test
    public void fixtures_zeroCostMarkers_usageNumTurnsConversationAllEmpty() {
        for (String fixture : new String[]{FULL_USAGE_PAYLOAD, WEEKLY_ONLY_USAGE_PAYLOAD}) {
            JsonObject p = payload(fixture);
            assertEquals("SUCCESS", p.get("status").getAsString());
            assertTrue("zero-cost marker: command object must be present",
                    p.has("command") && p.getAsJsonObject("command").has("data"));
            assertEquals(0, p.get("num_turns").getAsInt());
            assertEquals("", p.get("conversation_id").getAsString());
            JsonObject usage = p.getAsJsonObject("usage");
            for (String k : new String[]{"input_tokens", "output_tokens", "thinking_tokens",
                    "cache_read_tokens", "total_tokens"}) {
                assertEquals("usage." + k + " must be zero", 0, usage.get(k).getAsInt());
            }
        }
    }

    // ===== version gate + payload-status discipline (AC4, NFR6, C13) =====

    @Test
    public void parseUsagePayload_successWithoutCommandMarker_returnsNull() {
        assertNull(GeminiPlanUsageService.parseUsagePayload(
                payload(OLD_CLI_PAYLOAD), "gemini-3.7-flash-high"));
    }

    @Test
    public void parseUsagePayload_errorStatus_returnsNullWithoutMappingResponseText() {
        assertNull(GeminiPlanUsageService.parseUsagePayload(
                payload(ERROR_STATUS_PAYLOAD), "gemini-3.7-flash-high"));
    }

    @Test
    public void resolvePlanUsagePayload_versionBelowProductFloor_returnsUpgradeHintWithoutSpawningProbe() {
        // THE forbidden failure mode (NFR6): on < 1.1.11 the same text runs as a
        // MODEL PROMPT and burns tokens — the probe must never spawn at all.
        int[] calls = {0};
        GeminiPlanUsageService.setAgyTransportForTests(() -> {
            calls[0]++;
            return payload(FULL_USAGE_PAYLOAD);
        });
        for (String version : new String[]{"1.1.10", "1.0.9", null}) {
            GeminiPlanUsageService.setCliVersionForTests(version);
            JsonObject out = GeminiPlanUsageService.resolvePlanUsagePayload(
                    "gemini-3.7-flash-high", 1_000_000L);
            assertFalse("quota must be unavailable on version " + version,
                    out.get("present").getAsBoolean());
            assertTrue(out.get("unavailable").getAsBoolean());
            assertEquals("gemini", out.get("provider").getAsString());
            String message = out.get("message").getAsString();
            assertTrue("upgrade hint must name the remedy (agy update): " + message,
                    message.contains("agy update"));
            assertTrue("hint must state the product floor: " + message,
                    message.contains("1.1.11"));
        }
        assertEquals("probe must NEVER spawn when the version gate fails", 0, calls[0]);
    }

    @Test
    public void resolvePlanUsagePayload_successWithoutCommandMarker_returnsUpgradeHintSingleProbe() {
        // Belt-and-braces: a SUCCESS payload lacking `command` IS the old-CLI
        // marker — treat as unavailable + hint, and never retry in a loop.
        int[] calls = {0};
        GeminiPlanUsageService.setCliVersionForTests("1.1.26");
        GeminiPlanUsageService.setAgyTransportForTests(() -> {
            calls[0]++;
            return payload(OLD_CLI_PAYLOAD);
        });
        JsonObject out = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", 1_000_000L);
        assertFalse(out.get("present").getAsBoolean());
        assertTrue(out.get("message").getAsString().contains("agy update"));
        assertEquals("exactly one probe, no retry loop", 1, calls[0]);
    }

    // ===== caching (TTL / stale / family keying) =====

    @Test
    public void resolvePlanUsagePayload_cacheTtlEnforced_andRefreshTracksDepletion() {
        int[] calls = {0};
        GeminiPlanUsageService.setCliVersionForTests("1.1.26");
        GeminiPlanUsageService.setAgyTransportForTests(() -> {
            calls[0]++;
            return payload(calls[0] == 1 ? FULL_USAGE_PAYLOAD : DEPLETED_USAGE_PAYLOAD);
        });
        long t0 = 1_000_000L;

        JsonObject first = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", t0);
        assertEquals(58.0, first.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals(1, calls[0]);

        // Within TTL → cached, no second probe
        JsonObject cached = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", t0 + GeminiPlanUsageService.CACHE_TTL_MS - 1);
        assertEquals(58.0, cached.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals(1, calls[0]);

        // TTL expired → fresh probe; backend depletion becomes visible (AC6)
        JsonObject refreshed = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", t0 + GeminiPlanUsageService.CACHE_TTL_MS + 1);
        assertEquals(100.0, refreshed.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals(2, calls[0]);
    }

    @Test
    public void resolvePlanUsagePayload_cacheKeyedByFamily_switchNeverServesOtherFamily() {
        int[] calls = {0};
        GeminiPlanUsageService.setCliVersionForTests("1.1.26");
        GeminiPlanUsageService.setAgyTransportForTests(() -> {
            calls[0]++;
            return payload(FULL_USAGE_PAYLOAD);
        });
        long t0 = 1_000_000L;

        JsonObject gemini = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", t0);
        assertEquals(1, calls[0]);

        // Switch family within TTL → cache miss (different key), 3P numbers served
        JsonObject thirdParty = GeminiPlanUsageService.resolvePlanUsagePayload(
                "claude-sonnet-4-6", t0 + 1);
        assertEquals(2, calls[0]);
        assertNotNull(findWindow(thirdParty, "3p-5h"));
        assertNull("a family switch must never serve the other family's numbers",
                findWindow(thirdParty, "gemini-5h"));

        // Back to gemini within TTL → served from the gemini cache, no new probe
        JsonObject geminiAgain = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", t0 + 2);
        assertEquals(2, calls[0]);
        assertNotNull(findWindow(geminiAgain, "gemini-5h"));
    }

    @Test
    public void resolvePlanUsagePayload_staleFallbackOnProbeFailure_boundedWindow() {
        boolean[] fail = {false};
        GeminiPlanUsageService.setCliVersionForTests("1.1.26");
        GeminiPlanUsageService.setAgyTransportForTests(() -> {
            if (fail[0]) {
                throw new IllegalStateException("spawn failed");
            }
            return payload(FULL_USAGE_PAYLOAD);
        });
        long t0 = 1_000_000L;
        GeminiPlanUsageService.resolvePlanUsagePayload("gemini-3.7-flash-high", t0);

        fail[0] = true;
        JsonObject stale = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", t0 + GeminiPlanUsageService.CACHE_TTL_MS + 1);
        assertEquals("last good data stays visible on a failed refresh",
                58.0, stale.get("capacity_pct").getAsDouble(), 0.01);
        assertTrue(stale.get("stale").getAsBoolean());

        // Beyond the stale cap → honest unavailability, no masquerading
        JsonObject gaveUp = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", t0 + GeminiPlanUsageService.STALE_MAX_MS + 1);
        assertFalse(gaveUp.get("present").getAsBoolean());
    }

    @Test
    public void resolvePlanUsagePayload_transportFailureWithNoCache_returnsUnavailableNeverThrows() {
        GeminiPlanUsageService.setCliVersionForTests("1.1.26");
        GeminiPlanUsageService.setAgyTransportForTests(() -> {
            throw new IllegalStateException("agy not found");
        });
        JsonObject out = GeminiPlanUsageService.resolvePlanUsagePayload(
                "gemini-3.7-flash-high", 1_000_000L);
        assertFalse(out.get("present").getAsBoolean());
        assertTrue(out.get("unavailable").getAsBoolean());
        assertEquals("gemini", out.get("provider").getAsString());
    }
}
