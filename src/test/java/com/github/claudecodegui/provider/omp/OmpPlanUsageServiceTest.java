package com.github.claudecodegui.provider.omp;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

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
    public void freshReadingOfOneModelSurvivesResolvingAnother() {
        AtomicInteger calls = new AtomicInteger();
        long[] now = {1_000_000L};
        Function<String, JsonObject> runner = m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        };
        OmpPlanUsageService.resolve("auto", runner, () -> now[0]);
        OmpPlanUsageService.resolve("smol", runner, () -> now[0]);
        assertEquals(2, calls.get());

        now[0] += OmpPlanUsageService.FRESH_MS - 1;
        OmpPlanUsageService.resolve("auto", runner, () -> now[0]);
        OmpPlanUsageService.resolve("smol", runner, () -> now[0]);
        assertEquals("both readings are still fresh", 2, calls.get());

        now[0] += 1;
        OmpPlanUsageService.resolve("auto", runner, () -> now[0]);
        assertEquals("an expired reading is read again", 3, calls.get());
    }

    @Test
    public void oldestModelIsEvictedWhenTheCacheIsFull() {
        AtomicInteger calls = new AtomicInteger();
        Function<String, JsonObject> runner = m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        };
        int models = 40;
        for (int i = 0; i < models; i++) {
            OmpPlanUsageService.resolve("vendor/model-" + i, runner, () -> 1_000L);
        }
        assertEquals(models, calls.get());

        OmpPlanUsageService.resolve("vendor/model-" + (models - 1), runner, () -> 1_000L);
        assertEquals("the newest reading is kept", models, calls.get());
        OmpPlanUsageService.resolve("vendor/model-0", runner, () -> 1_000L);
        assertEquals("the oldest reading was evicted", models + 1, calls.get());
    }

    @Test
    public void unavailableIsRetriedAfterItsShortTtlPerModel() {
        AtomicInteger calls = new AtomicInteger();
        long[] now = {5_000_000L};
        JsonObject first = OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return OmpPlanUsageService.unavailable("no usage");
        }, () -> now[0]);
        assertFalse(first.get("present").getAsBoolean());
        assertEquals("no usage", first.get("message").getAsString());

        now[0] += OmpPlanUsageService.UNAVAILABLE_MS / 2;
        OmpPlanUsageService.resolve("smol", m -> {
            calls.incrementAndGet();
            return OmpPlanUsageService.unavailable("no usage");
        }, () -> now[0]);
        assertEquals(2, calls.get());

        now[0] += OmpPlanUsageService.UNAVAILABLE_MS / 2 - 1;
        OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals("a failed read is not repeated early", 2, calls.get());

        now[0] += 1;
        JsonObject recovered = OmpPlanUsageService.resolve("auto", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals(3, calls.get());
        assertTrue(recovered.get("present").getAsBoolean());

        // smol failed 10s after auto, so its retry window has not opened yet.
        OmpPlanUsageService.resolve("smol", m -> {
            calls.incrementAndGet();
            return json(PRESENT_LINE);
        }, () -> now[0]);
        assertEquals("each model keeps its own retry window", 3, calls.get());
    }

    @Test(timeout = 30_000)
    public void differentModelsRunSideBySide() throws Exception {
        CountDownLatch bothInBridge = new CountDownLatch(2);
        Function<String, JsonObject> runner = m -> {
            bothInBridge.countDown();
            try {
                // Runs serialized behind one lock would leave the first one waiting for a second
                // run that can never start.
                if (!bothInBridge.await(10, TimeUnit.SECONDS)) {
                    return OmpPlanUsageService.unavailable("runs were serialized");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return OmpPlanUsageService.unavailable("interrupted");
            }
            return json(PRESENT_LINE);
        };

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<JsonObject> opus = pool.submit(
                    () -> OmpPlanUsageService.resolve("anthropic/claude-opus-5-5", runner, () -> 1_000L));
            Future<JsonObject> gpt = pool.submit(
                    () -> OmpPlanUsageService.resolve("openai/gpt-5.5", runner, () -> 1_000L));
            assertTrue(opus.get(20, TimeUnit.SECONDS).get("present").getAsBoolean());
            assertTrue(gpt.get(20, TimeUnit.SECONDS).get("present").getAsBoolean());
        } finally {
            pool.shutdownNow();
        }
    }

    @Test(timeout = 30_000)
    public void concurrentRequestsForOneModelShareOneBridgeRun() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        CountDownLatch inBridge = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Function<String, JsonObject> runner = m -> {
            calls.incrementAndGet();
            inBridge.countDown();
            try {
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return json(PRESENT_LINE);
        };

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<JsonObject> first = pool.submit(() -> OmpPlanUsageService.resolve("auto", runner, () -> 1_000L));
            assertTrue(inBridge.await(10, TimeUnit.SECONDS));

            AtomicReference<Thread> secondThread = new AtomicReference<>();
            Future<JsonObject> second = pool.submit(() -> {
                secondThread.set(Thread.currentThread());
                return OmpPlanUsageService.resolve("auto", runner, () -> 1_000L);
            });
            // The second request parks on the first run (or, if the run were not shared, inside the
            // runner on `release`); either way it is blocked, so the count below tells them apart.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while ((secondThread.get() == null || secondThread.get().getState() != Thread.State.WAITING)
                    && System.nanoTime() < deadline) {
                Thread.yield();
            }
            release.countDown();

            JsonObject firstPayload = first.get(20, TimeUnit.SECONDS);
            JsonObject secondPayload = second.get(20, TimeUnit.SECONDS);
            assertEquals("one bridge run served both requests", 1, calls.get());
            assertTrue(firstPayload.get("present").getAsBoolean());
            assertEquals(firstPayload, secondPayload);
            firstPayload.addProperty("mutated", true);
            assertFalse("callers get their own copy", secondPayload.has("mutated"));
        } finally {
            pool.shutdownNow();
        }
    }

    @Test(timeout = 30_000)
    public void aFailedSharedRunReleasesTheWaitingRequest() throws Exception {
        CountDownLatch inBridge = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Function<String, JsonObject> runner = m -> {
            inBridge.countDown();
            try {
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            throw new IllegalStateException("spawn failed");
        };

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<JsonObject> first = pool.submit(() -> OmpPlanUsageService.resolve("auto", runner, () -> 1_000L));
            assertTrue(inBridge.await(10, TimeUnit.SECONDS));
            AtomicReference<Thread> secondThread = new AtomicReference<>();
            Future<JsonObject> second = pool.submit(() -> {
                secondThread.set(Thread.currentThread());
                return OmpPlanUsageService.resolve("auto", runner, () -> 1_000L);
            });
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while ((secondThread.get() == null || secondThread.get().getState() != Thread.State.WAITING)
                    && System.nanoTime() < deadline) {
                Thread.yield();
            }
            release.countDown();

            for (Future<JsonObject> result : List.of(first, second)) {
                JsonObject payload = result.get(20, TimeUnit.SECONDS);
                assertFalse(payload.get("present").getAsBoolean());
                assertEquals("spawn failed", payload.get("message").getAsString());
            }
        } finally {
            pool.shutdownNow();
        }
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
