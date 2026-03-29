package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.diagnostic.Logger;

import com.github.claudecodegui.diagnostics.DiagnosticConfig;
import com.github.claudecodegui.diagnostics.DiagnosticManager;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.service.TrackerParser;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.CompletableFuture;

/**
 * F-007: Diagnostic snapshot handler.
 * Receives webview-side snapshots, enriches them with Java-side state,
 * and writes them to ~/.codemoss/diagnostics/snapshots/.
 */
public class DiagnosticHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DiagnosticHandler.class);

    private static final String[] SUPPORTED_TYPES = {
            "diagnostic_snapshot",
            "get_diagnostics_enabled",
            "set_diagnostics_enabled",
            "get_known_bugs",
            "get_tracker_path",
            "set_tracker_path",
            "get_ipc_sniffer_config",
            "set_ipc_sniffer_enabled",
    };

    private final Gson gson = new Gson();
    private DiagnosticManager diagnosticManager;

    public DiagnosticHandler(HandlerContext context) {
        super(context);
    }

    /**
     * Set the diagnostic manager reference (for IPC sniffer control).
     * Called from DiagnosticManager.init() after handler registration.
     */
    public void setDiagnosticManager(DiagnosticManager dm) {
        this.diagnosticManager = dm;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "diagnostic_snapshot":
                handleSnapshot(content);
                return true;
            case "get_diagnostics_enabled":
                handleGetDiagnosticsEnabled();
                return true;
            case "set_diagnostics_enabled":
                handleSetDiagnosticsEnabled(content);
                return true;
            case "get_known_bugs":
                handleGetKnownBugs();
                return true;
            case "get_tracker_path":
                handleGetTrackerPath();
                return true;
            case "set_tracker_path":
                handleSetTrackerPath(content);
                return true;
            case "get_ipc_sniffer_config":
                if (diagnosticManager != null) diagnosticManager.handleGetSnifferConfig(context);
                return true;
            case "set_ipc_sniffer_enabled":
                handleSetIpcSnifferEnabled(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Handle incoming diagnostic snapshot from webview.
     * Enriches with Java state and writes to disk asynchronously.
     */
    private void handleSnapshot(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject webviewSnapshot = JsonParser.parseString(content).getAsJsonObject();
                String bugId = webviewSnapshot.has("bugId") ? webviewSnapshot.get("bugId").getAsString() : "UNKNOWN";
                long timestamp = System.currentTimeMillis();

                // Build enriched snapshot
                JsonObject enriched = new JsonObject();
                enriched.addProperty("version", 1);
                enriched.addProperty("bugId", bugId);
                enriched.addProperty("timestamp", webviewSnapshot.has("timestamp")
                        ? webviewSnapshot.get("timestamp").getAsString()
                        : new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").format(new java.util.Date()));
                enriched.addProperty("trigger", webviewSnapshot.has("trigger")
                        ? webviewSnapshot.get("trigger").getAsString()
                        : "unknown");

                // Webview section
                JsonObject webview = new JsonObject();
                if (webviewSnapshot.has("events")) webview.add("events", webviewSnapshot.get("events"));
                if (webviewSnapshot.has("scroll")) webview.add("scroll", webviewSnapshot.get("scroll"));
                if (webviewSnapshot.has("streaming")) webview.add("streaming", webviewSnapshot.get("streaming"));
                if (webviewSnapshot.has("app")) webview.add("app", webviewSnapshot.get("app"));
                enriched.add("webview", webview);

                // Java session state
                JsonObject javaState = new JsonObject();
                var session = context.getSession();
                if (session != null) {
                    javaState.addProperty("sessionId", session.getSessionId());
                    javaState.addProperty("channelId", session.getChannelId());
                    javaState.addProperty("busy", session.isBusy());
                    javaState.addProperty("loading", session.isLoading());
                    javaState.addProperty("error", session.getError());
                    javaState.addProperty("model", session.getModel());
                    javaState.addProperty("provider", session.getProvider());
                    javaState.addProperty("cwd", session.getCwd());
                    javaState.addProperty("permissionMode", session.getPermissionMode());
                } else {
                    javaState.addProperty("sessionId", (String) null);
                    javaState.addProperty("note", "no active session");
                }
                javaState.addProperty("currentModel", context.getCurrentModel());
                javaState.addProperty("currentProvider", context.getCurrentProvider());
                enriched.add("java", javaState);

                // Environment info
                JsonObject environment = new JsonObject();
                try {
                    ApplicationInfo appInfo = ApplicationInfo.getInstance();
                    environment.addProperty("ideVersion", appInfo.getFullVersion());
                    environment.addProperty("ideBuild", appInfo.getBuild().asString());
                } catch (Exception e) {
                    environment.addProperty("ideVersion", "unknown");
                }
                environment.addProperty("pluginVersion", getPluginVersion());
                environment.addProperty("javaVersion", System.getProperty("java.version", "unknown"));
                environment.addProperty("os", System.getProperty("os.name", "unknown") + " " + System.getProperty("os.version", ""));

                Runtime runtime = Runtime.getRuntime();
                environment.addProperty("jvmTotalMemory", runtime.totalMemory());
                environment.addProperty("jvmFreeMemory", runtime.freeMemory());
                environment.addProperty("jvmMaxMemory", runtime.maxMemory());
                enriched.add("environment", environment);

                // Write to disk
                Path snapshotsDir = getSnapshotsDirectory();
                Files.createDirectories(snapshotsDir);

                String fileName = bugId + "_" + timestamp + ".json";
                Path snapshotFile = snapshotsDir.resolve(fileName);
                Files.writeString(snapshotFile, gson.toJson(enriched), StandardCharsets.UTF_8);

                LOG.info("[DiagnosticHandler] Snapshot saved: " + snapshotFile);

                // Notify webview of success
                JsonObject result = new JsonObject();
                result.addProperty("success", true);
                result.addProperty("bugId", bugId);
                result.addProperty("filePath", snapshotFile.toString());
                callJavaScript("window.onDiagnosticSnapshotResult", escapeJs(gson.toJson(result)));

            } catch (Exception e) {
                LOG.error("[DiagnosticHandler] Failed to save snapshot: " + e.getMessage(), e);

                JsonObject result = new JsonObject();
                result.addProperty("success", false);
                result.addProperty("error", e.getMessage());
                callJavaScript("window.onDiagnosticSnapshotResult", escapeJs(gson.toJson(result)));
            }
        });
    }

    private void handleGetDiagnosticsEnabled() {
        boolean enabled = DiagnosticConfig.getDiagnosticsEnabled();
        JsonObject response = new JsonObject();
        response.addProperty("diagnosticsEnabled", enabled);
        callJavaScript("window.updateDiagnosticsEnabled", escapeJs(gson.toJson(response)));
    }

    /**
     * Handle request for known bugs list — parses TRACKER.md on demand.
     */
    private void handleGetKnownBugs() {
        String bugsJson = TrackerParser.getOpenBugsAsJson(context.getProject());
        callJavaScript("setKnownBugs", escapeJs(bugsJson));
    }

    private void handleGetTrackerPath() {
        String path = DiagnosticConfig.getTrackerPath();
        boolean exists = DiagnosticConfig.trackerFileExists(path);
        JsonObject response = new JsonObject();
        response.addProperty("path", path);
        response.addProperty("exists", exists);
        callJavaScript("updateTrackerPath", escapeJs(gson.toJson(response)));
    }

    private void handleSetTrackerPath(String content) {
        JsonObject json = JsonParser.parseString(content).getAsJsonObject();
        String path = json.has("path") ? json.get("path").getAsString() : "";
        DiagnosticConfig.setTrackerPath(path);
        boolean exists = DiagnosticConfig.trackerFileExists(path);
        JsonObject response = new JsonObject();
        response.addProperty("path", path);
        response.addProperty("exists", exists);
        response.addProperty("saved", true);
        callJavaScript("updateTrackerPath", escapeJs(gson.toJson(response)));
    }

    private void handleSetDiagnosticsEnabled(String content) {
        JsonObject json = JsonParser.parseString(content).getAsJsonObject();
        boolean enabled = json.has("diagnosticsEnabled") && json.get("diagnosticsEnabled").getAsBoolean();
        DiagnosticConfig.setDiagnosticsEnabled(enabled);
        // No push-back to webview — it already has the correct state.
        // Pushing back would cause an infinite loop: webview → Java → webview → …
    }

    private void handleSetIpcSnifferEnabled(String content) {
        if (diagnosticManager == null) return;
        JsonObject json = JsonParser.parseString(content).getAsJsonObject();
        boolean enabled = json != null && json.has("enabled") && json.get("enabled").getAsBoolean();
        diagnosticManager.handleSetSnifferEnabled(enabled, context);
    }

    /**
     * Get the snapshots directory: ~/.codemoss/diagnostics/snapshots/
     */
    private Path getSnapshotsDirectory() {
        return Paths.get(com.github.claudecodegui.util.PlatformUtils.getHomeDirectory(), ".codemoss", "diagnostics", "snapshots");
    }

    /**
     * Get the plugin version from the plugin descriptor.
     */
    private String getPluginVersion() {
        try {
            var plugins = com.intellij.ide.plugins.PluginManagerCore.getPlugins();
            for (var descriptor : plugins) {
                if (descriptor.getPluginId().getIdString().contains("claudecodegui")
                        || descriptor.getPluginId().getIdString().contains("claude-code-gui")) {
                    return descriptor.getVersion();
                }
            }
        } catch (Exception e) {
            // Fallback
        }
        return "unknown";
    }
}
