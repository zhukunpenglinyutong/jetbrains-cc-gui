package com.github.claudecodegui.provider.omp;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.LongSupplier;

/**
 * OMP plan-usage snapshot for the ContextBar.
 *
 * <p>The webview polls {@code get_omp_plan_usage}. The bridge command
 * {@code channel-manager.js omp getPlanUsage <model>} runs {@code omp usage --json} and
 * prints the capacity payload. Readings are cached per model, and concurrent requests for the
 * same model share one bridge run, while different models run side by side: the lock below only
 * guards the bookkeeping maps and is never held while a bridge process runs.
 */
public final class OmpPlanUsageService {

    private static final Logger LOG = Logger.getInstance(OmpPlanUsageService.class);
    private static final Gson GSON = new Gson();

    /** Just under the webview's one-minute cadence, so a regular tick re-reads. */
    static final long FRESH_MS = 55_000L;
    /** A failed read is not repeated sooner than this. */
    static final long UNAVAILABLE_MS = 20_000L;

    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    /** The bridge bounds its own omp calls at 30s + 15s. */
    private static final long PROCESS_TIMEOUT_SECONDS = 60L;
    private static final int MAX_OUTPUT_CHARS = 64_000;

    /** Models kept in the cache; the oldest reading is evicted first. */
    private static final int MAX_CACHED_MODELS = 8;

    private static final Object LOCK = new Object();
    /** Insertion-ordered, so the first entry is the oldest reading. Guarded by {@link #LOCK}. */
    private static final Map<String, Entry> CACHE = new LinkedHashMap<>();
    /** Bridge runs under way, by model. Guarded by {@link #LOCK}. */
    private static final Map<String, CompletableFuture<JsonObject>> IN_FLIGHT = new HashMap<>();

    private record Entry(JsonObject payload, long atMs, long ttlMs) {
    }

    private OmpPlanUsageService() {
    }

    /**
     * Payload for {@code model} (the plugin's model id: {@code auto}, a role id or a selector).
     * Never null.
     */
    public static JsonObject resolvePlanUsagePayload(String model) {
        return resolve(model, OmpPlanUsageService::runBridge, System::currentTimeMillis);
    }

    static JsonObject resolve(
            String model,
            Function<String, JsonObject> runner,
            LongSupplier clock
    ) {
        String key = model == null ? "" : model.trim();
        long startMs = clock.getAsLong();
        CompletableFuture<JsonObject> run;
        boolean owner = false;
        synchronized (LOCK) {
            Entry cached = CACHE.get(key);
            if (cached != null && startMs >= cached.atMs() && startMs - cached.atMs() < cached.ttlMs()) {
                return cached.payload().deepCopy();
            }
            run = IN_FLIGHT.get(key);
            if (run == null) {
                run = new CompletableFuture<>();
                IN_FLIGHT.put(key, run);
                owner = true;
            }
        }

        if (!owner) {
            try {
                return run.get().deepCopy();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return unavailable("OMP usage interrupted");
            } catch (ExecutionException e) {
                return unavailable(e.getMessage());
            }
        }

        JsonObject payload = unavailable(null);
        try {
            JsonObject result = runner.apply(key);
            if (result != null) {
                payload = result;
            }
        } catch (Exception e) {
            LOG.warn("[OMP] plan-usage run failed: " + e.getMessage());
            payload = unavailable(e.getMessage());
        } finally {
            // Runs on an Error too, so threads waiting on this model are always released.
            long atMs = Math.max(startMs, clock.getAsLong());
            long ttlMs = isPresent(payload) ? FRESH_MS : UNAVAILABLE_MS;
            synchronized (LOCK) {
                CACHE.remove(key);
                CACHE.put(key, new Entry(payload.deepCopy(), atMs, ttlMs));
                Iterator<String> oldest = CACHE.keySet().iterator();
                while (CACHE.size() > MAX_CACHED_MODELS) {
                    oldest.next();
                    oldest.remove();
                }
                IN_FLIGHT.remove(key, run);
            }
            run.complete(payload.deepCopy());
        }
        return payload;
    }

    /**
     * Last JSON-object line of the bridge output that carries the capacity {@code present}
     * flag, or the unavailable payload when there is none.
     */
    static JsonObject extractPayload(String raw) {
        if (raw != null) {
            String[] lines = raw.split("\\R");
            for (int i = lines.length - 1; i >= 0; i--) {
                String line = lines[i].trim();
                if (!line.startsWith("{") || !line.endsWith("}")) {
                    continue;
                }
                try {
                    JsonObject obj = GSON.fromJson(line, JsonObject.class);
                    if (obj != null && obj.has("present")) {
                        return obj;
                    }
                } catch (Exception ignored) {
                    // Diagnostics that merely look like JSON; keep looking upward.
                }
            }
        }
        return unavailable("No plan-usage payload from OMP");
    }

    /** Same shape as the bridge's and Grok's unavailable payload. */
    static JsonObject unavailable(String message) {
        JsonObject out = new JsonObject();
        out.addProperty("present", false);
        out.addProperty("unavailable", true);
        out.addProperty("provider", "omp");
        out.addProperty("source", "omp usage");
        out.addProperty("message", message != null ? message : "OMP usage unavailable");
        return out;
    }

    static void resetCacheForTests() {
        synchronized (LOCK) {
            CACHE.clear();
            IN_FLIGHT.clear();
        }
    }

    private static boolean isPresent(JsonObject payload) {
        return payload.has("present")
                && payload.get("present").isJsonPrimitive()
                && payload.get("present").getAsJsonPrimitive().isBoolean()
                && payload.get("present").getAsBoolean();
    }

    private static JsonObject runBridge(String model) {
        try {
            String node = NodeDetector.getInstance().findNodeExecutable();
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null || !bridgeDir.exists()) {
                return unavailable("Bridge directory not ready");
            }
            File script = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!script.exists()) {
                return unavailable("channel-manager.js not found");
            }

            List<String> command = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                    node, script.getAbsolutePath()));
            command.add("omp");
            command.add("getPlanUsage");
            // An empty argv slot would be dropped by some launchers; "auto" means the default role.
            command.add(model.isEmpty() ? "auto" : model);

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);
            new EnvironmentConfigurator().updateProcessEnvironment(pb, node);

            Process process = pb.start();
            // Drain on a daemon thread (bounded) so a verbose child cannot block on a full pipe.
            StringBuilder output = new StringBuilder();
            Thread reader = new Thread(() -> {
                try (BufferedReader in = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = in.readLine()) != null) {
                        synchronized (output) {
                            if (output.length() < MAX_OUTPUT_CHARS) {
                                output.append(line).append('\n');
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // Stream closed with the process.
                }
            });
            reader.setDaemon(true);
            reader.start();

            if (!process.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return unavailable("Timed out reading OMP usage");
            }
            reader.join(2000L);
            synchronized (output) {
                return extractPayload(output.toString());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return unavailable("OMP usage interrupted");
        } catch (Exception e) {
            LOG.warn("[OMP] plan-usage bridge failed: " + e.getMessage());
            return unavailable(e.getMessage());
        }
    }
}
