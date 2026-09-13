package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.dsh.DshEnvSupport;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * DSH host lifecycle + connection settings for the Settings CLI card.
 *
 * <p>Frontend protocol:
 * <ul>
 *   <li>{@code sendToJava('get_dsh_status')} → {@code window.updateDshStatus(json)}</li>
 *   <li>{@code sendToJava('start_dsh_host')} → {@code window.updateDshStatus(json)}</li>
 *   <li>{@code sendToJava('stop_dsh_host')} → {@code window.updateDshStatus(json)}</li>
 *   <li>{@code sendToJava('save_dsh_settings:<json>')} → persists the {@code dsh}
 *       config section and replies {@code window.updateDshStatus(json)}</li>
 * </ul>
 *
 * <p>Only bin / host / port / autoStart live here. Provider keys and the model
 * catalog stay in the DSH Web UI ($DSH_HOME) — the plugin never writes them.
 */
public class DshHostHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DshHostHandler.class);
    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final long STATUS_TIMEOUT_SECONDS = 30L;
    private static final long LIFECYCLE_TIMEOUT_SECONDS = 60L;
    private static final int MAX_OUTPUT_CHARS = 64_000;
    // stderr is drained on its own thread and only the tail is kept, for
    // diagnostics on timeout/failure — it must never block the child process.
    private static final int MAX_STDERR_CHARS = 8_192;

    private static final String[] SUPPORTED_TYPES = {
            "get_dsh_status",
            "start_dsh_host",
            "stop_dsh_host",
            "save_dsh_settings",
    };

    private final Gson gson = new Gson();
    private final NodeDetector nodeDetector = NodeDetector.getInstance();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();
    private final CodemossSettingsService settingsService = new CodemossSettingsService();
    // Re-entry guard for start/stop (double clicks); status polls stay unrestricted.
    private final AtomicBoolean lifecycleInProgress = new AtomicBoolean(false);

    public DshHostHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_dsh_status":
                CompletableFuture.runAsync(
                        () -> pushStatus(runDshCommand("status", null, STATUS_TIMEOUT_SECONDS)),
                        AppExecutorUtil.getAppExecutorService());
                return true;
            case "start_dsh_host":
                runLifecycleCommand("ensureHost", LIFECYCLE_TIMEOUT_SECONDS);
                return true;
            case "stop_dsh_host":
                runLifecycleCommand("stopHost", STATUS_TIMEOUT_SECONDS);
                return true;
            case "save_dsh_settings":
                saveSettings(content);
                CompletableFuture.runAsync(
                        () -> pushStatus(runDshCommand("status", null, STATUS_TIMEOUT_SECONDS)),
                        AppExecutorUtil.getAppExecutorService());
                return true;
            default:
                return false;
        }
    }

    /**
     * Guard start/stop against re-entry: while one lifecycle command runs,
     * further start/stop requests get an explicit "in progress" error instead
     * of racing it. Status polls are not guarded.
     */
    private void runLifecycleCommand(String command, long timeoutSeconds) {
        if (!lifecycleInProgress.compareAndSet(false, true)) {
            pushStatus(errorPayload("DSH host operation already in progress"));
            return;
        }
        CompletableFuture.runAsync(() -> {
            try {
                pushStatus(runDshCommand(command, null, timeoutSeconds));
            } finally {
                lifecycleInProgress.set(false);
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    private void saveSettings(String content) {
        try {
            if (content == null || content.isBlank()) {
                return;
            }
            JsonObject payload = JsonParser.parseString(content).getAsJsonObject();

            // Parse and validate every field first, then persist in one pass —
            // a failure must never leave the dsh section half-written.
            String bin = null;
            if (payload.has("bin")) {
                bin = payload.get("bin").isJsonNull() ? "" : payload.get("bin").getAsString().trim();
                String binError = validateDshBin(bin);
                if (binError != null) {
                    pushStatus(errorPayload(binError));
                    return;
                }
            }
            String host = null;
            if (payload.has("host")) {
                host = payload.get("host").isJsonNull() ? "" : payload.get("host").getAsString().trim();
                String hostError = validateDshHost(host);
                if (hostError != null) {
                    pushStatus(errorPayload(hostError));
                    return;
                }
            }
            Integer port = null;
            if (payload.has("port") && !payload.get("port").isJsonNull()) {
                port = payload.get("port").getAsInt();
            }
            Boolean autoStart = null;
            if (payload.has("autoStart") && !payload.get("autoStart").isJsonNull()) {
                autoStart = payload.get("autoStart").getAsBoolean();
            }

            if (bin != null) {
                settingsService.setDshBin(bin);
            }
            if (host != null) {
                settingsService.setDshHost(host);
            }
            if (port != null) {
                settingsService.setDshPort(port);
            }
            if (autoStart != null) {
                settingsService.setDshAutoStart(autoStart);
            }
        } catch (Exception e) {
            LOG.warn("[DshHost] Failed to save settings: " + e.getMessage());
            pushStatus(errorPayload("Invalid DSH settings: "
                    + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName())));
        }
    }

    /**
     * Validate a DSH host value: host name or IP only — no whitespace, scheme
     * or port ({@code :}), and no path separators. Empty clears the override
     * (the default host applies).
     *
     * @return an error message when invalid, null when acceptable
     */
    // VisibleForTesting
    static String validateDshHost(String host) {
        if (host == null || host.isEmpty()) {
            return null;
        }
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            if (Character.isWhitespace(c) || c == '/' || c == '\\' || c == ':') {
                return "Invalid DSH host (host name or IP only, no scheme or port): " + host;
            }
        }
        return null;
    }

    /**
     * Validate a DSH bin path: reject control characters/newlines and, when the
     * path exists, anything that is not a regular file. Empty clears the
     * override (PATH lookup applies).
     *
     * @return an error message when invalid, null when acceptable
     */
    // VisibleForTesting
    static String validateDshBin(String bin) {
        if (bin == null || bin.isEmpty()) {
            return null;
        }
        for (int i = 0; i < bin.length(); i++) {
            if (Character.isISOControl(bin.charAt(i))) {
                return "Invalid DSH bin path (contains control characters)";
            }
        }
        File candidate = new File(bin);
        if (candidate.exists() && !candidate.isFile()) {
            return "Invalid DSH bin path (not a regular file): " + bin;
        }
        return null;
    }

    private JsonObject runDshCommand(String command, JsonObject stdinPayload, long timeoutSeconds) {
        Process process = null;
        try {
            String node = nodeDetector.findNodeExecutable();
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null || !bridgeDir.exists()) {
                return errorPayload("Bridge directory not ready");
            }
            File script = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!script.exists()) {
                return errorPayload("channel-manager.js not found");
            }

            List<String> cmd = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                    node, script.getAbsolutePath()));
            cmd.add("dsh");
            cmd.add(command);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(false);
            envConfigurator.updateProcessEnvironment(pb, node);
            DshEnvSupport.inject(pb.environment(), settingsService);
            if (stdinPayload != null) {
                pb.environment().put("DSH_USE_STDIN", "true");
            }

            process = pb.start();
            writeStdin(process, stdinPayload);

            StringBuilder output = new StringBuilder();
            StringBuilder stderrTail = new StringBuilder();
            Thread stdoutReader = drainStdout(process, output);
            Thread stderrDrainer = drainStderr(process, stderrTail);

            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                LOG.warn("[DshHost] dsh " + command + " timed out" + stderrSuffix(stderrTail));
                return errorPayload("Timed out running dsh " + command + stderrSuffix(stderrTail));
            }
            stdoutReader.join(2000L);
            stderrDrainer.join(2000L);

            JsonObject payload = extractJsonObject(output.toString());
            if (payload == null) {
                LOG.warn("[DshHost] no JSON output from dsh " + command + stderrSuffix(stderrTail));
                return errorPayload("No JSON output from dsh " + command + stderrSuffix(stderrTail));
            }
            return payload;
        } catch (Exception e) {
            LOG.warn("[DshHost] " + command + " failed: " + e.getMessage());
            return errorPayload(e.getMessage() != null ? e.getMessage() : "dsh " + command + " failed");
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    /**
     * Write the optional JSON payload to the child stdin and close it, so the
     * Node side never waits on an open stream.
     */
    private void writeStdin(Process process, JsonObject stdinPayload) throws IOException {
        if (stdinPayload != null) {
            try (OutputStream stdin = process.getOutputStream()) {
                stdin.write((gson.toJson(stdinPayload) + "\n").getBytes(StandardCharsets.UTF_8));
                stdin.flush();
            }
        } else {
            process.getOutputStream().close();
        }
    }

    /**
     * Drain the child stdout into {@code output} (bounded at
     * {@link #MAX_OUTPUT_CHARS}) on a named daemon thread.
     */
    private Thread drainStdout(Process process, StringBuilder output) {
        Thread thread = new Thread(() -> {
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
            } catch (Exception e) {
                LOG.debug("[DshHost] stdout reader stopped: " + e.getMessage());
            }
        }, "dsh-host-stdout-reader");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    /**
     * Drain the child stderr on a named daemon thread, keeping only the last
     * {@link #MAX_STDERR_CHARS} chars. Without this the child blocks once its
     * stderr pipe buffer fills (~64KB), which previously looked like a timeout
     * and swallowed all failure diagnostics.
     */
    private Thread drainStderr(Process process, StringBuilder stderrTail) {
        Thread thread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    synchronized (stderrTail) {
                        stderrTail.append(line).append('\n');
                        if (stderrTail.length() > MAX_STDERR_CHARS) {
                            stderrTail.delete(0, stderrTail.length() - MAX_STDERR_CHARS);
                        }
                    }
                }
            } catch (Exception e) {
                LOG.debug("[DshHost] stderr drainer stopped: " + e.getMessage());
            }
        }, "dsh-host-stderr-drainer");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    /**
     * Render the captured stderr tail as a log/error-message suffix, or an
     * empty string when the child wrote nothing to stderr.
     */
    private String stderrSuffix(StringBuilder stderrTail) {
        synchronized (stderrTail) {
            String tail = stderrTail.toString().trim();
            return tail.isEmpty() ? "" : " (stderr: " + tail + ")";
        }
    }

    private JsonObject errorPayload(String message) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", false);
        payload.addProperty("provider", "dsh");
        payload.addProperty("error", message);
        return payload;
    }

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
                JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
                if (obj != null) {
                    return obj;
                }
            } catch (Exception e) {
                LOG.debug("[DshHost] skipping non-JSON output line: " + e.getMessage());
            }
        }
        return null;
    }

    private void pushStatus(JsonObject payload) {
        if (payload == null) {
            payload = errorPayload("no result");
        }
        // Always echo the effective settings so the card can reflect them.
        try {
            JsonObject settings = new JsonObject();
            settings.addProperty("bin", settingsService.getDshBin());
            settings.addProperty("host", settingsService.getDshHost());
            settings.addProperty("port", settingsService.getDshPort());
            settings.addProperty("autoStart", settingsService.getDshAutoStart());
            payload.add("settings", settings);
        } catch (Exception e) {
            LOG.debug("[DshHost] failed to attach settings echo: " + e.getMessage());
        }
        callJavaScript("window.updateDshStatus", escapeJs(gson.toJson(payload)));
    }
}
