package com.github.claudecodegui.skill;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * Slash command catalog of the OMP CLI, fetched through the bridge
 * ({@code channel-manager.js omp listCommands <cwd>}) and cached per working directory.
 *
 * <p>OMP does not understand Claude's built-ins, so the {@code /} list for provider
 * {@code omp} comes only from here. {@link #getCached(String)} never blocks; a
 * directory that was never fetched, or whose last fetch failed, has an empty list.
 * Fetching spawns {@code omp} and must stay off the EDT: use {@link #refresh(String)}.
 */
public final class OmpSlashCommandService {

    public static final String PROVIDER = "omp";

    private static final Logger LOG = Logger.getInstance(OmpSlashCommandService.class);
    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    // The bridge allows ~20s for omp to become ready plus ~20s for the response.
    private static final long TIMEOUT_SECONDS = 50L;
    private static final int MAX_OUTPUT_CHARS = 256_000;
    private static final Gson GSON = new Gson();

    private static final Map<String, List<SlashCommandRegistry.SlashCommand>> CACHE = new ConcurrentHashMap<>();
    private static final Map<String, CompletableFuture<List<SlashCommandRegistry.SlashCommand>>> IN_FLIGHT =
            new ConcurrentHashMap<>();

    private OmpSlashCommandService() {
    }

    public static boolean isOmp(String provider) {
        return PROVIDER.equalsIgnoreCase(provider);
    }

    /** Normalizes a working directory into the cache key; null and blank share one key. */
    public static String cacheKey(String cwd) {
        return cwd == null ? "" : cwd.trim();
    }

    /** Last successfully fetched commands for the directory, empty when there are none. */
    public static List<SlashCommandRegistry.SlashCommand> getCached(String cwd) {
        List<SlashCommandRegistry.SlashCommand> cached = CACHE.get(cacheKey(cwd));
        return cached != null ? cached : List.of();
    }

    public static boolean hasCached(String cwd) {
        return CACHE.containsKey(cacheKey(cwd));
    }

    /**
     * Fetches the catalog on a pooled thread and stores it. Concurrent calls for one
     * directory share a single fetch. The future always completes normally: a failed
     * fetch evicts the directory's cache entry and yields an empty list.
     */
    public static CompletableFuture<List<SlashCommandRegistry.SlashCommand>> refresh(String cwd) {
        String key = cacheKey(cwd);
        CompletableFuture<List<SlashCommandRegistry.SlashCommand>> created = new CompletableFuture<>();
        CompletableFuture<List<SlashCommandRegistry.SlashCommand>> existing = IN_FLIGHT.putIfAbsent(key, created);
        if (existing != null) {
            return existing;
        }
        AppExecutorUtil.getAppExecutorService().execute(() -> {
            List<SlashCommandRegistry.SlashCommand> result;
            try {
                result = fetchAndStore(key);
            } catch (Throwable t) {
                LOG.warn("[OmpSlashCommands] Unexpected failure for cwd=" + key + ": " + t.getMessage(), t);
                CACHE.remove(key);
                result = List.of();
            }
            IN_FLIGHT.remove(key, created);
            created.complete(result);
        });
        return created;
    }

    /**
     * Refreshes the directory and hands the resulting command list, serialized for the
     * webview, to {@code push} unless {@code stillCurrent} reports that the provider or
     * directory moved on while omp was starting.
     */
    public static void refreshAndPush(String cwd, BooleanSupplier stillCurrent, Consumer<String> push) {
        refresh(cwd).thenAccept(commands -> {
            if (stillCurrent.getAsBoolean()) {
                push.accept(SlashCommandRegistry.toJson(commands));
            }
        }).exceptionally(ex -> {
            LOG.warn("[OmpSlashCommands] Failed to push commands: " + ex.getMessage(), ex);
            return null;
        });
    }

    static void clearCache() {
        CACHE.clear();
        IN_FLIGHT.clear();
    }

    static void putCached(String cwd, List<SlashCommandRegistry.SlashCommand> commands) {
        CACHE.put(cacheKey(cwd), List.copyOf(commands));
    }

    private static List<SlashCommandRegistry.SlashCommand> fetchAndStore(String key) {
        Optional<List<SlashCommandRegistry.SlashCommand>> fetched = runBridge(key);
        if (fetched.isEmpty()) {
            CACHE.remove(key);
            return List.of();
        }
        List<SlashCommandRegistry.SlashCommand> commands = List.copyOf(fetched.get());
        CACHE.put(key, commands);
        LOG.info("[OmpSlashCommands] " + commands.size() + " commands for cwd=" + key);
        return commands;
    }

    private static Optional<List<SlashCommandRegistry.SlashCommand>> runBridge(String cwd) {
        try {
            NodeDetector nodeDetector = NodeDetector.getInstance();
            String node = nodeDetector.findNodeExecutable();
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null || !bridgeDir.exists()) {
                LOG.warn("[OmpSlashCommands] Bridge directory not ready");
                return Optional.empty();
            }
            File script = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!script.exists()) {
                LOG.warn("[OmpSlashCommands] " + CHANNEL_SCRIPT + " not found in " + bridgeDir);
                return Optional.empty();
            }

            List<String> command = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                    node, script.getAbsolutePath()));
            command.add(PROVIDER);
            command.add("listCommands");
            command.add(cwd);

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);
            new EnvironmentConfigurator().updateProcessEnvironment(pb, node);

            LOG.info("[OmpSlashCommands] Listing commands: " + String.join(" ", command));
            Process process = pb.start();
            // Drain stdout on a daemon thread so a chatty child cannot fill the pipe
            // while this thread enforces the timeout.
            StringBuilder output = new StringBuilder();
            Thread readerThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        synchronized (output) {
                            if (output.length() < MAX_OUTPUT_CHARS) {
                                output.append(line).append('\n');
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // Reader ends with the process; a partial buffer is parsed as-is.
                }
            });
            readerThread.setDaemon(true);
            readerThread.start();

            if (!process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                LOG.warn("[OmpSlashCommands] Timed out listing commands for cwd=" + cwd);
                return Optional.empty();
            }
            readerThread.join(2000L);

            String raw;
            synchronized (output) {
                raw = output.toString();
            }
            Optional<List<SlashCommandRegistry.SlashCommand>> parsed = parseBridgeOutput(raw);
            if (parsed.isEmpty()) {
                LOG.warn("[OmpSlashCommands] No usable listCommands result for cwd=" + cwd);
            }
            return parsed;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            LOG.warn("[OmpSlashCommands] Interrupted while listing commands");
            return Optional.empty();
        } catch (Exception e) {
            LOG.warn("[OmpSlashCommands] Failed to list commands: " + e.getMessage(), e);
            return Optional.empty();
        }
    }

    /**
     * Parses bridge output (stdout and stderr merged; the last JSON object line wins).
     * Empty when no result line exists or the bridge reported {@code success:false}.
     */
    static Optional<List<SlashCommandRegistry.SlashCommand>> parseBridgeOutput(String raw) {
        JsonObject payload = extractResultObject(raw);
        if (payload == null) {
            return Optional.empty();
        }
        JsonElement success = payload.get("success");
        if (success == null || !success.isJsonPrimitive() || !success.getAsJsonPrimitive().isBoolean()
                || !success.getAsBoolean()) {
            JsonElement error = payload.get("error");
            LOG.warn("[OmpSlashCommands] listCommands failed: "
                    + (error != null && error.isJsonPrimitive() ? error.getAsString() : "unknown error"));
            return Optional.empty();
        }
        return Optional.of(toCommands(payload.get("commands")));
    }

    /**
     * Converts bridge entries into registry commands: slash-prefixed name, the
     * description followed by the argument hint (if any), bridge source as source.
     * The hint goes last because the dropdown truncates descriptions from the start in
     * a right-to-left box, where leading {@code [..]} / {@code <..>} would be reordered.
     * Entries without a name are dropped and duplicate names keep the first.
     */
    static List<SlashCommandRegistry.SlashCommand> toCommands(JsonElement commandsElement) {
        if (commandsElement == null || !commandsElement.isJsonArray()) {
            return List.of();
        }
        JsonArray array = commandsElement.getAsJsonArray();
        Map<String, SlashCommandRegistry.SlashCommand> merged = new LinkedHashMap<>();
        for (JsonElement element : array) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject entry = element.getAsJsonObject();
            String bare = stringField(entry, "name").replaceFirst("^/+", "").trim();
            if (bare.isEmpty()) {
                continue;
            }
            String name = "/" + bare;
            String display = (stringField(entry, "description") + " " + stringField(entry, "argumentHint")).trim();
            merged.putIfAbsent(name, new SlashCommandRegistry.SlashCommand(name, display, stringField(entry, "source")));
        }
        return new ArrayList<>(merged.values());
    }

    private static String stringField(JsonObject object, String field) {
        JsonElement value = object.get(field);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
                ? value.getAsString()
                : "";
    }

    private static JsonObject extractResultObject(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        String[] lines = raw.split("\\R");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (!line.startsWith("{") || !line.endsWith("}")) {
                continue;
            }
            try {
                JsonObject obj = GSON.fromJson(line, JsonObject.class);
                if (obj != null && (obj.has("success") || obj.has("commands"))) {
                    return obj;
                }
            } catch (Exception ignored) {
                // Diagnostics that merely look like JSON; keep scanning upwards.
            }
        }
        return null;
    }
}
