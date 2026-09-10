package com.github.claudecodegui.provider.zcode;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Reads ZCode session history by querying the app-server through one-shot
 * channel-manager commands ({@code node channel-manager.js zcode listSessions |
 * getSessionMessages | deleteSession}).
 *
 * <p>ZCode keeps its transcripts inside the desktop client's own storage — there
 * is no stable on-disk layout for the plugin to scan, so (unlike the Grok/MiniMax
 * readers) nothing here touches the filesystem directly. Each command receives
 * its parameters as a stdin JSON document (gated by {@code ZCODE_USE_STDIN=true})
 * and prints a single result JSON line on stdout.
 */
public class ZcodeHistoryReader {

    private static final Logger LOG = Logger.getInstance(ZcodeHistoryReader.class);
    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final String PROVIDER = "zcode";
    private static final long TIMEOUT_SECONDS = 50L;
    /**
     * Cap on captured stdout — full transcripts can be large, but an unbounded
     * buffer risks memory exhaustion on a misbehaving child.
     */
    private static final int MAX_OUTPUT_CHARS = 8_000_000;

    private final Gson gson = new Gson();
    private final NodeDetector nodeDetector = NodeDetector.getInstance();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    /**
     * List sessions for a project, returned as the channel-manager JSON payload:
     * {@code {success, sessions: [...], sessionCount, total, provider: "zcode"}}.
     */
    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            JsonObject stdin = new JsonObject();
            stdin.addProperty("cwd", projectPath != null ? projectPath : "");
            JsonObject result = runCommand("listSessions", stdin);
            if (result == null) {
                return errorJson("No listSessions result from ZCode channel-manager");
            }
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[ZcodeHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            return errorJson("Failed to read ZCode sessions: " + e.getMessage());
        }
    }

    /**
     * Messages of one session as Claude-shaped objects
     * ({@code {type, uuid?, timestamp?, message: {role, content: [...]}}}).
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        List<JsonObject> messages = new ArrayList<>();
        try {
            JsonObject stdin = new JsonObject();
            stdin.addProperty("sessionId", sessionId != null ? sessionId : "");
            stdin.addProperty("cwd", cwd != null ? cwd : "");
            JsonObject result = runCommand("getSessionMessages", stdin);
            if (result == null) {
                return messages;
            }
            if (result.has("success") && !result.get("success").getAsBoolean()) {
                LOG.warn("[ZcodeHistoryReader] getSessionMessages failed: " + result);
                return messages;
            }
            if (result.has("messages") && result.get("messages").isJsonArray()) {
                JsonArray arr = result.getAsJsonArray("messages");
                for (int i = 0; i < arr.size(); i++) {
                    if (arr.get(i).isJsonObject()) {
                        messages.add(arr.get(i).getAsJsonObject());
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[ZcodeHistoryReader] Failed to load session messages: " + e.getMessage(), e);
        }
        return messages;
    }

    /** Delete one session via the app-server; true when the command reports success. */
    public boolean deleteSession(String sessionId, String projectPath) {
        try {
            JsonObject stdin = new JsonObject();
            stdin.addProperty("sessionId", sessionId != null ? sessionId : "");
            stdin.addProperty("cwd", projectPath != null ? projectPath : "");
            JsonObject result = runCommand("deleteSession", stdin);
            boolean deleted = result != null
                    && result.has("success")
                    && result.get("success").getAsBoolean();
            if (!deleted) {
                LOG.warn("[ZcodeHistoryReader] deleteSession not confirmed: " + result);
            }
            return deleted;
        } catch (Exception e) {
            LOG.warn("[ZcodeHistoryReader] Failed to delete session: " + e.getMessage(), e);
            return false;
        }
    }

    // ============================================================================
    // One-shot channel-manager process (same spawn pattern as CliModelsHandler)
    // ============================================================================

    private JsonObject runCommand(String command, JsonObject stdinPayload) throws Exception {
        String node = nodeDetector.findNodeExecutable();
        BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
        File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
        if (bridgeDir == null || !bridgeDir.exists()) {
            LOG.warn("[ZcodeHistoryReader] Bridge directory not ready");
            return null;
        }

        File script = new File(bridgeDir, CHANNEL_SCRIPT);
        if (!script.exists()) {
            LOG.warn("[ZcodeHistoryReader] channel-manager.js not found");
            return null;
        }

        List<String> cmd = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                node, script.getAbsolutePath()));
        cmd.add(PROVIDER);
        cmd.add(command);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(bridgeDir);
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("ZCODE_USE_STDIN", "true");
        envConfigurator.updateProcessEnvironment(pb, node);

        LOG.info("[ZcodeHistoryReader] Running: " + String.join(" ", cmd));

        Process process = pb.start();

        // Parameters go over stdin (ZCODE_USE_STDIN=true); close it so the child
        // does not wait for more input.
        try (OutputStreamWriter writer = new OutputStreamWriter(
                process.getOutputStream(), StandardCharsets.UTF_8)) {
            writer.write(gson.toJson(stdinPayload != null ? stdinPayload : new JsonObject()));
            writer.flush();
        } catch (Exception e) {
            LOG.warn("[ZcodeHistoryReader] Failed to write stdin: " + e.getMessage());
        }

        // Drain stdout on a daemon thread (bounded) so a verbose child cannot
        // deadlock on a full pipe buffer while this thread enforces the timeout.
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
            }
        });
        readerThread.setDaemon(true);
        readerThread.start();

        boolean finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            LOG.warn("[ZcodeHistoryReader] Timed out running zcode " + command);
            return null;
        }
        // Process exited; the reader hits EOF promptly — join for the final lines.
        readerThread.join(2000L);

        return extractJsonObject(output.toString());
    }

    /** Last parseable JSON object line (channel-manager may print diagnostics first). */
    private JsonObject extractJsonObject(String raw) {
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
                JsonObject obj = gson.fromJson(line, JsonObject.class);
                if (obj != null) {
                    return obj;
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private String errorJson(String message) {
        Map<String, Object> error = new HashMap<>();
        error.put("success", false);
        error.put("error", message);
        error.put("provider", PROVIDER);
        return gson.toJson(error);
    }
}
