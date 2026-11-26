package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Reads Antigravity subscription quota through the locally signed-in CLI. */
public final class GeminiPlanUsageService {

    static final long CACHE_TTL_MS = 30_000L;
    static final long FAILURE_TTL_MS = 3_000L;
    static final long UNSUPPORTED_TTL_MS = 10 * 60_000L;
    // Includes CLI discovery, version verification and cold WSL startup in addition to /usage.
    private static final int BRIDGE_TIMEOUT_SECONDS = 50;
    private static final int MAX_OUTPUT_BYTES = 256 * 1024;
    private static final String SCRIPT = "services/gemini/quota-probe.js";
    private static final List<String> BUCKET_ORDER = List.of(
            "gemini-5h", "gemini-weekly", "gemini-argon-wtu-weekly", "3p-5h", "3p-weekly");
    private static final List<String> REASONS = List.of("cli_missing", "cli_outdated", "no_quota", "timeout", "query_failed");
    private static final Logger LOG = Logger.getInstance(GeminiPlanUsageService.class);
    private static final QuotaReader READER = new QuotaReader(
            () -> NodeDetector.getInstance().getCachedNodePath(), GeminiPlanUsageService::runBridgeProbe, System::currentTimeMillis,
            task -> ApplicationManager.getApplication().executeOnPooledThread(task));

    private GeminiPlanUsageService() {
    }

    /** Requests an account-wide quota snapshot without blocking the caller. */
    public static CompletableFuture<JsonObject> requestPlanUsage() {
        return READER.fetch();
    }

    static final class QuotaReader {
        private final Supplier<String> runtime;
        private final UsageProbe probe;
        private final LongSupplier clock;
        private final Executor executor;
        private CachedQuota cached;
        private PendingQuota inFlight;

        QuotaReader(Supplier<String> runtime, UsageProbe probe, LongSupplier clock, Executor executor) {
            this.runtime = runtime;
            this.probe = probe;
            this.clock = clock;
            this.executor = executor;
        }

        CompletableFuture<JsonObject> fetch() {
            PendingQuota request;
            synchronized (this) {
                String node = this.runtime.get();
                // A native Windows result must not be reused after switching the bridge to WSL.
                if (this.cached != null && Objects.equals(this.cached.node(), node) && this.clock.getAsLong() < this.cached.expiresAt()) {
                    return CompletableFuture.completedFuture(this.cached.payload().deepCopy());
                }
                if (this.inFlight != null && Objects.equals(this.inFlight.node(), node)) {
                    return this.inFlight.result().thenApply(JsonObject::deepCopy);
                }
                request = new PendingQuota(node, new CompletableFuture<>());
                this.inFlight = request;
            }
            // Joining an existing probe should not occupy another pooled thread.
            try {
                this.executor.execute(() -> this.finish(request));
            } catch (RuntimeException e) {
                this.complete(request, unavailable("query_failed"), FAILURE_TTL_MS);
            }
            return request.result().thenApply(JsonObject::deepCopy);
        }

        private void finish(PendingQuota request) {
            JsonObject payload;
            long ttl = FAILURE_TTL_MS;
            try {
                JsonObject result = this.probe.read(request.node());
                payload = parseBridgePayload(result, this.clock.getAsLong());
                if ("ok".equals(stringField(payload, "status"))) {
                    ttl = CACHE_TTL_MS;
                } else if ("cli_outdated".equals(stringField(payload, "reasonCode")) && isTrue(result, "legacyModelTurn")) {
                    // Avoid repeating a billable prompt when a launcher reported a misleading version.
                    ttl = UNSUPPORTED_TTL_MS;
                }
            } catch (TimeoutException e) {
                payload = unavailable("timeout");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                payload = unavailable("query_failed");
            } catch (Exception e) {
                // CLI output and exception messages may contain account or local configuration details.
                LOG.debug("Antigravity quota probe failed: " + e.getClass().getSimpleName());
                payload = unavailable("query_failed");
            }
            this.complete(request, payload, ttl);
        }

        private void complete(PendingQuota request, JsonObject payload, long ttl) {
            synchronized (this) {
                String currentNode = this.runtime.get();
                if (this.inFlight != request || (request.node() != null && !Objects.equals(request.node(), currentNode))) {
                    payload = unavailable("query_failed");
                } else {
                    this.cached = new CachedQuota(currentNode, this.clock.getAsLong() + ttl, payload);
                }
                if (this.inFlight == request) {
                    this.inFlight = null;
                }
            }
            request.result().complete(payload);
        }
    }

    @FunctionalInterface
    interface UsageProbe {
        JsonObject read(String configuredNode) throws Exception;
    }

    private record PendingQuota(String node, CompletableFuture<JsonObject> result) {
    }

    private record CachedQuota(String node, long expiresAt, JsonObject payload) {
    }

    static JsonObject parseBridgePayload(JsonObject result, long fetchedAt) {
        if ("SUCCESS".equals(stringField(result, "status"))) {
            return parseUsagePayload(result, fetchedAt);
        }
        String reason = stringField(result, "reasonCode");
        if (!"unavailable".equals(stringField(result, "status")) || reason == null || !REASONS.contains(reason)) {
            return unavailable("query_failed");
        }
        JsonObject payload = unavailable(reason);
        if ("cli_outdated".equals(reason)) {
            String version = stringField(result, "minimumVersion");
            if (version == null || !version.matches("[0-9]+\\.[0-9]+\\.[0-9]+")) {
                return unavailable("query_failed");
            }
            payload.addProperty("minimumVersion", version);
        }
        return payload;
    }

    private static JsonObject parseUsagePayload(JsonObject output, long fetchedAt) {
        JsonObject command = objectField(output, "command");
        if (!"usage".equals(stringField(command, "name"))) {
            return unavailable("query_failed");
        }
        Map<String, JsonObject> byId = new HashMap<>();
        // The CLI may rename or reorder groups. Billing identity lives on the bucket, not the display name.
        for (JsonElement group : arrayField(objectField(command, "data"), "groups")) {
            for (JsonElement bucket : arrayField(asObject(group), "buckets")) {
                JsonObject row = parseBucket(asObject(bucket));
                if (row != null) {
                    byId.putIfAbsent(row.get("id").getAsString(), row);
                }
            }
        }
        if (byId.isEmpty()) {
            return unavailable("no_quota");
        }
        JsonArray windows = new JsonArray();
        for (String id : BUCKET_ORDER) {
            if (byId.containsKey(id)) {
                windows.add(byId.get(id));
            }
        }
        JsonObject payload = new JsonObject();
        payload.addProperty("status", "ok");
        payload.addProperty("fetchedAt", fetchedAt);
        payload.add("windows", windows);
        return payload;
    }

    private static JsonObject parseBucket(JsonObject bucket) {
        String id = stringField(bucket, "id");
        if (id == null || !BUCKET_ORDER.contains(id)) {
            return null;
        }
        JsonElement fraction = bucket.get("remaining_fraction");
        if (fraction == null || !fraction.isJsonPrimitive() || !fraction.getAsJsonPrimitive().isNumber()) {
            return null;
        }
        double remaining = fraction.getAsDouble();
        if (!Double.isFinite(remaining) || remaining < 0 || remaining > 1) {
            return null;
        }
        JsonObject row = new JsonObject();
        row.addProperty("id", id);
        row.addProperty("remainingPercent", remaining * 100);
        String resetsAt = stringField(bucket, "reset_time");
        if (resetsAt != null) {
            try {
                row.addProperty("resetsAt", Instant.parse(resetsAt).toEpochMilli());
            } catch (DateTimeParseException | ArithmeticException ignored) {
                // A bad timestamp does not invalidate a known remaining fraction.
            }
        }
        return row;
    }

    private static JsonObject unavailable(String reason) {
        JsonObject payload = new JsonObject();
        payload.addProperty("status", "unavailable");
        payload.addProperty("reasonCode", reason);
        return payload;
    }

    private static JsonObject runBridgeProbe(String configuredNode) throws Exception {
        String node = configuredNode != null ? configuredNode : NodeDetector.getInstance().findNodeExecutable();
        File bridgeDir = BridgePreloader.getSharedResolver().findSdkDir();
        if (bridgeDir == null) {
            return unavailable("query_failed");
        }
        File script = new File(bridgeDir, SCRIPT);
        if (!script.isFile()) {
            return unavailable("query_failed");
        }
        ProcessBuilder builder = new ProcessBuilder(NodeDetector.buildNodeScriptCommand(node, script.getAbsolutePath()));
        builder.directory(bridgeDir);
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        new EnvironmentConfigurator().updateProcessEnvironment(builder, node);
        Process process = builder.start();
        FutureTask<String> stdout = new FutureTask<>(() -> readStdout(process.getInputStream()));
        Thread reader = new Thread(stdout, "agy-quota-stdout");
        reader.setDaemon(true);
        try {
            process.getOutputStream().close();
            reader.start();
            if (!process.waitFor(BRIDGE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new TimeoutException();
            }
            if (!node.equals(NodeDetector.getInstance().getCachedNodePath()) || process.exitValue() != 0) {
                return null;
            }
            return asObject(JsonParser.parseString(stdout.get(1, TimeUnit.SECONDS)));
        } finally {
            if (process.isAlive()) {
                PlatformUtils.terminateProcess(process);
            }
            stdout.cancel(true);
        }
    }

    private static String readStdout(InputStream stream) throws IOException {
        try (stream) {
            byte[] output = stream.readNBytes(MAX_OUTPUT_BYTES + 1);
            if (output.length > MAX_OUTPUT_BYTES) {
                throw new IOException("Quota response exceeded the output limit");
            }
            return new String(output, StandardCharsets.UTF_8);
        }
    }

    private static String stringField(JsonObject object, String name) {
        JsonElement value = object == null ? null : object.get(name);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : null;
    }

    private static boolean isTrue(JsonObject object, String name) {
        JsonElement value = object == null ? null : object.get(name);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean() && value.getAsBoolean();
    }

    private static JsonObject objectField(JsonObject object, String name) {
        return object == null ? null : asObject(object.get(name));
    }

    private static JsonObject asObject(JsonElement value) {
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }

    private static JsonArray arrayField(JsonObject object, String name) {
        JsonElement value = object == null ? null : object.get(name);
        return value != null && value.isJsonArray() ? value.getAsJsonArray() : new JsonArray();
    }
}
