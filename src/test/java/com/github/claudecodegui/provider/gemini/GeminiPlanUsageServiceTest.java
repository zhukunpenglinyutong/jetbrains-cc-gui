package com.github.claudecodegui.provider.gemini;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.StreamSupport;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies the account-wide quota contract and shared request lifetime. */
public class GeminiPlanUsageServiceTest {

    private static final String OUTPUT = """
            {
              "status": "SUCCESS", "conversation_id": "", "num_turns": 0,
              "usage": {"input_tokens": 0, "output_tokens": 0},
              "command": {"name": "usage", "data": {"groups": [
                {"name": "Localized third-party group", "buckets": [
                  {"id": "3p-weekly", "remaining_fraction": 0.25, "reset_time": "2026-10-27T23:16:37Z"},
                  {"id": "3p-5h", "remaining_fraction": 0, "reset_time": "2026-10-21T04:16:37Z"}
                ]},
                {"buckets": [
                  {"id": "gemini-argon-wtu-weekly", "remaining_fraction": 0.8, "reset_time": "2026-10-27T18:00:00Z"},
                  {"id": "gemini-weekly", "remaining_fraction": 0.75, "reset_time": "2026-10-27T15:13:36Z"},
                  {"id": "gemini-5h", "remaining_fraction": 1, "reset_time": "2026-10-21T04:16:37Z"},
                  {"id": "future-bucket", "remaining_fraction": 0.5},
                  {"id": "gemini-5h", "remaining_fraction": 0}
                ]}
              ]}}
            }
            """;

    /** Uses stable IDs and the published billing order rather than group display names. */
    @Test
    public void readsAllRecognizedBucketsInOrderRegardlessOfGroupNames() {
        JsonObject snapshot = GeminiPlanUsageService.parseBridgePayload(parse(OUTPUT), 3000);
        assertEquals("ok", snapshot.get("status").getAsString());
        assertEquals(3000, snapshot.get("fetchedAt").getAsLong());
        List<JsonObject> windows = windows(snapshot);
        assertEquals(List.of("gemini-5h", "gemini-weekly", "gemini-argon-wtu-weekly", "3p-5h", "3p-weekly"),
                windows.stream().map(row -> row.get("id").getAsString()).toList());
        assertEquals(List.of(100.0, 75.0, 80.0, 0.0, 25.0),
                windows.stream().map(row -> row.get("remainingPercent").getAsDouble()).toList());
        assertEquals(Instant.parse("2026-10-27T18:00:00Z").toEpochMilli(), windows.get(2).get("resetsAt").getAsLong());
        assertEquals(Instant.parse("2026-10-27T23:16:37Z").toEpochMilli(), windows.get(4).get("resetsAt").getAsLong());
    }

    /** Missing or malformed native values do not become invented quota windows. */
    @Test
    public void weeklyOnlyAccountDoesNotInventOtherBucketsOrResetTimes() {
        JsonObject snapshot = GeminiPlanUsageService.parseBridgePayload(parse("""
                {"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"buckets":[
                  {"id":"3p-weekly","remaining_fraction":0.42,"reset_time":"unknown"},
                  {"id":"gemini-weekly"}, {"id":"3p-5h","remaining_fraction":null},
                  {"id":"gemini-5h","remaining_fraction":"0.5"}, {"id":"gemini-argon-wtu-weekly","remaining_fraction":1e400},
                  {"id":"gemini-weekly","remaining_fraction":-0.01}, {"id":"3p-5h","remaining_fraction":1.01}
                ]}]}}}
                """), 3000);
        List<JsonObject> windows = windows(snapshot);
        assertEquals(1, windows.size());
        assertEquals("3p-weekly", windows.get(0).get("id").getAsString());
        assertEquals(42, windows.get(0).get("remainingPercent").getAsDouble(), 0.001);
        assertFalse(windows.get(0).has("resetsAt"));
    }

    /** Keeps execution failure distinct from a successful query with no known quota. */
    @Test
    public void distinguishesBrokenRepliesFromEmptyQuota() {
        for (String output : List.of(
                OUTPUT.replace("SUCCESS", "ERROR"),
                OUTPUT.replace("\"name\": \"usage\"", "\"name\": \"some-other-command\""),
                "{\"status\":\"SUCCESS\",\"response\":\"100% available\"}",
                "{\"status\":\"unavailable\",\"reasonCode\":\"cli_outdated\"}")) {
            JsonObject snapshot = GeminiPlanUsageService.parseBridgePayload(parse(output), 3000);
            assertEquals("query_failed", snapshot.get("reasonCode").getAsString());
            assertFalse(snapshot.has("windows"));
        }
        JsonObject empty = GeminiPlanUsageService.parseBridgePayload(
                parse("{\"status\":\"SUCCESS\",\"command\":{\"name\":\"usage\",\"data\":{\"groups\":[]}}}"), 3000);
        assertEquals("no_quota", empty.get("reasonCode").getAsString());
    }

    /** A legacy CLI that accidentally ran a model turn should not repeat that turn on the next hover. */
    @Test
    public void suppressesRepeatedLegacyTurnsAfterAMisleadingVersion() {
        AtomicLong clock = new AtomicLong(3000);
        AtomicInteger calls = new AtomicInteger();
        var reader = new GeminiPlanUsageService.QuotaReader(() -> "node", node ->calls.incrementAndGet() == 1
                ? parse("{\"status\":\"unavailable\",\"reasonCode\":\"cli_outdated\",\"minimumVersion\":\"1.1.11\",\"legacyModelTurn\":true}")
                : parse(OUTPUT), clock::get, Runnable::run);
        JsonObject legacy = reader.fetch().join();
        assertEquals("cli_outdated", legacy.get("reasonCode").getAsString());
        assertFalse(legacy.has("legacyModelTurn"));
        clock.addAndGet(GeminiPlanUsageService.UNSUPPORTED_TTL_MS - 1);
        assertEquals(legacy, reader.fetch().join());
        assertEquals(1, calls.get());
        clock.incrementAndGet();
        assertEquals("ok", reader.fetch().join().get("status").getAsString());
        assertEquals(2, calls.get());
    }

    /** Cached results retain their original timestamp and never mask a failed refresh. */
    @Test
    public void cachesTheActualFetchTimeAndDoesNotCarryStaleQuotaAcrossFailure() {
        AtomicLong clock = new AtomicLong(3000);
        AtomicInteger calls = new AtomicInteger();
        var reader = new GeminiPlanUsageService.QuotaReader(() -> "node", node ->{
            if (calls.incrementAndGet() == 1) {
                clock.addAndGet(8000);
                return parse(OUTPUT);
            }
            throw new TimeoutException();
        }, clock::get, Runnable::run);
        JsonObject first = reader.fetch().join();
        assertEquals(11000, first.get("fetchedAt").getAsLong());
        first.remove("windows");
        clock.addAndGet(GeminiPlanUsageService.CACHE_TTL_MS - 1);
        assertEquals(5, windows(reader.fetch().join()).size());
        assertEquals(1, calls.get());
        clock.incrementAndGet();
        JsonObject failed = reader.fetch().join();
        assertEquals("timeout", failed.get("reasonCode").getAsString());
        assertFalse(failed.has("windows"));
        assertEquals(2, calls.get());
        assertEquals(failed, reader.fetch().join());
        assertEquals(2, calls.get());
    }

    /** Additional requests share the in-flight probe without occupying other worker threads. */
    @Test
    public void sharesOneCliProbeAcrossConcurrentRequests() {
        List<Runnable> tasks = new ArrayList<>();
        var reader = new GeminiPlanUsageService.QuotaReader(() -> "node", node ->parse(OUTPUT), () -> 3000, tasks::add);
        var first = reader.fetch();
        var second = reader.fetch();
        assertFalse(first.isDone());
        assertFalse(second.isDone());
        assertEquals(1, tasks.size());
        tasks.get(0).run();
        assertEquals(first.join(), second.join());
        first.join().remove("windows");
        assertTrue(second.join().has("windows"));
    }

    /** A native probe cannot replace a WSL snapshot after the configured runtime changes. */
    @Test
    public void dropsResultsAndCacheFromTheOldRuntime() {
        AtomicReference<String> runtime = new AtomicReference<>("native-node");
        List<Runnable> tasks = new ArrayList<>();
        var reader = new GeminiPlanUsageService.QuotaReader(runtime::get,
                node -> parse("native-node".equals(node) ? OUTPUT : OUTPUT.replace("0.25", "0.15")), () -> 3000, tasks::add);
        var nativeReply = reader.fetch();
        runtime.set("wsl-node");
        var wslReply = reader.fetch();
        assertEquals(2, tasks.size());
        tasks.get(1).run();
        assertEquals(15.0, windows(wslReply.join()).get(4).get("remainingPercent").getAsDouble(), 0.001);
        tasks.get(0).run();
        assertEquals("query_failed", nativeReply.join().get("reasonCode").getAsString());
        assertEquals(wslReply.join(), reader.fetch().join());
        runtime.set("new-native-node");
        assertFalse(reader.fetch().isDone());
        assertEquals(3, tasks.size());
    }

    private static JsonObject parse(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static List<JsonObject> windows(JsonObject snapshot) {
        return StreamSupport.stream(snapshot.getAsJsonArray("windows").spliterator(), false)
                .map(element -> element.getAsJsonObject()).toList();
    }
}
