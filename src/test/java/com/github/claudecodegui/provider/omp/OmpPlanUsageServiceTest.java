package com.github.claudecodegui.provider.omp;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OmpPlanUsageServiceTest {

    private static final String PRESENT_LINE = "{\"ok\":true,\"present\":true,\"provider\":\"omp\","
            + "\"source\":\"omp usage\",\"capacity_pct\":10,\"period_type\":\"5h\","
            + "\"windows\":[{\"id\":\"5h\",\"used_pct\":10,\"reset_at\":\"2026-11-10T20:00:00Z\",\"period_type\":\"5h\"}]}";

    @Before
    public void setUp() {
        OmpPlanUsageService.resetCacheForTests();
    }

    @After
    public void tearDown() {
        OmpPlanUsageService.resetCacheForTests();
    }

    private static JsonObject json(String text) {
        return JsonParser.parseString(text).getAsJsonObject();
    }

    @Test
    public void extractPayloadPassesTheCapacityPayloadThrough() {
        String raw = "warming up\n" + PRESENT_LINE + "\n";
        JsonObject payload = OmpPlanUsageService.extractPayload(raw);
        assertEquals(json(PRESENT_LINE), payload);
    }

    @Test
    public void extractPayloadTakesTheLastPayloadLine() {
        String raw = "{\"present\":false}\n" + PRESENT_LINE + "\n{\"debug\":true}\n";
        assertTrue(OmpPlanUsageService.extractPayload(raw).get("present").getAsBoolean());
    }

    @Test
    public void extractPayloadWithoutJsonIsUnavailable() {
        for (String raw : new String[] {null, "", "boom\nnot json", "{\"success\":true}"}) {
            JsonObject payload = OmpPlanUsageService.extractPayload(raw);
            assertFalse(payload.get("present").getAsBoolean());
            assertTrue(payload.get("unavailable").getAsBoolean());
            assertEquals("omp", payload.get("provider").getAsString());
        }
    }

    @Test
    public void presentPayloadIsCachedPerModel() {
        AtomicInteger calls = new AtomicInteger();
        long[] now = {1_000_000L};
        JsonObject first = OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertTrue(first.get("present").getAsBoolean());

        now[0] += OmpPlanUsageService.FRESH_MS - 1;
        OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals(1, calls.get());

        // A different model must not be served from the other model's reading.
        OmpPlanUsageService.resolve("smol", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals(2, calls.get());

        now[0] += OmpPlanUsageService.FRESH_MS;
        OmpPlanUsageService.resolve("smol", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals(3, calls.get());
    }

    @Test
    public void unavailableIsRetriedAfterItsShortTtl() {
        AtomicInteger calls = new AtomicInteger();
        long[] now = {5_000_000L};
        JsonObject first = OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return OmpPlanUsageService.unavailable("no usage");
        }, () -> now[0]);
        assertFalse(first.get("present").getAsBoolean());
        assertEquals("no usage", first.get("message").getAsString());

        now[0] += OmpPlanUsageService.UNAVAILABLE_MS - 1;
        OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals(1, calls.get());

        now[0] += 1;
        JsonObject recovered = OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals(2, calls.get());
        assertTrue(recovered.get("present").getAsBoolean());
    }

    @Test
    public void runnerFailureYieldsUnavailable() {
        JsonObject payload = OmpPlanUsageService.resolve("auto", m -> {
            throw new IllegalStateException("spawn failed");
        }, () -> 1L);
        assertFalse(payload.get("present").getAsBoolean());
        assertTrue(payload.get("unavailable").getAsBoolean());
        assertEquals("spawn failed", payload.get("message").getAsString());
    }
}
