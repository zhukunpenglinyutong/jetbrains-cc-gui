package com.github.claudecodegui.diagnostics;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.github.claudecodegui.handler.DiagnosticFileWatcher;
import com.github.claudecodegui.handler.DiagnosticHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.core.MessageDispatcher;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.util.PlatformUtils;

import java.nio.file.Paths;

/**
 * F-007/F-010/F-012: Central diagnostic facade.
 * Owns all diagnostic subsystems — single entry point for ChatWindowDelegate.
 *
 * Upstream footprint: 1 field + init() + dispose() in ChatWindowDelegate.
 */
public class DiagnosticManager {

    private static final Logger LOG = Logger.getInstance(DiagnosticManager.class);
    private static final Gson GSON = new Gson();

    private DiagnosticFileWatcher fileWatcher;
    private IpcSnifferWriter ipcSnifferWriter;
    private volatile boolean ipcSnifferEnabled = false;

    /**
     * Initialize all diagnostic subsystems.
     * Call from ChatWindowDelegate.initializeHandlers() — single integration point.
     */
    public void init(HandlerContext handlerContext, MessageDispatcher messageDispatcher, ClaudeSDKBridge claudeSDKBridge) {
        // 1. Register DiagnosticHandler (handles snapshots, known bugs, tracker path, IPC config)
        DiagnosticHandler handler = new DiagnosticHandler(handlerContext);
        handler.setDiagnosticManager(this);
        messageDispatcher.registerHandler(handler);

        // 2. Start file watcher for cross-instance snapshot triggers
        fileWatcher = new DiagnosticFileWatcher(handlerContext);
        fileWatcher.start();

        // 3. Load saved IPC sniffer state and apply to bridge
        try {
            boolean saved = DiagnosticConfig.getIpcSnifferEnabled();
            if (saved) {
                enableSniffer();
                claudeSDKBridge.setDiagnosticManager(this);
            }
        } catch (Exception e) {
            LOG.debug("[DiagnosticManager] Failed to load initial IPC sniffer state: " + e.getMessage());
        }

        // Always set the manager reference so bridge can call log methods
        claudeSDKBridge.setDiagnosticManager(this);

        LOG.info("[DiagnosticManager] Initialized (fileWatcher, diagnosticHandler, ipcSniffer)");
    }

    /**
     * Cleanup all diagnostic subsystems.
     * Call from ChatWindowDelegate.dispose().
     */
    public void dispose() {
        if (fileWatcher != null) {
            fileWatcher.stop();
            fileWatcher = null;
        }
        shutdownSniffer();
    }

    // ========================================================================
    // F-010: IPC Sniffer — interceptor methods called by ClaudeSDKBridge
    // ========================================================================

    public void logOutbound(String sessionId, String channelId, String model, String mode, String sanitizedPayload) {
        if (ipcSnifferEnabled && ipcSnifferWriter != null) {
            ipcSnifferWriter.logOutbound(sessionId, channelId, model, mode, sanitizedPayload);
        }
    }

    public void logInbound(String sessionId, String line) {
        if (ipcSnifferEnabled && ipcSnifferWriter != null) {
            ipcSnifferWriter.logInbound(sessionId, line);
        }
    }

    /**
     * F-012: Log lifecycle events (webview_created, page_loaded, session_start, etc.)
     */
    public void logLifecycle(String event, String detail) {
        if (ipcSnifferEnabled && ipcSnifferWriter != null) {
            ipcSnifferWriter.logLifecycle(event, detail);
        }
    }

    public void shutdownSniffer() {
        if (ipcSnifferWriter != null) {
            ipcSnifferWriter.shutdown();
            ipcSnifferWriter = null;
        }
        ipcSnifferEnabled = false;
    }

    // ========================================================================
    // IPC Sniffer config (called by DiagnosticHandler)
    // ========================================================================

    public void handleGetSnifferConfig(HandlerContext context) {
        JsonObject response = new JsonObject();
        response.addProperty("enabled", ipcSnifferEnabled);
        context.callJavaScript("window.updateIpcSnifferConfig", context.escapeJs(GSON.toJson(response)));
    }

    public void handleSetSnifferEnabled(boolean enabled, HandlerContext context) {
        DiagnosticConfig.setIpcSnifferEnabled(enabled);

        if (enabled) {
            enableSniffer();
        } else {
            disableSniffer();
        }

        // Propagate to ALL open tabs (B-026)
        for (ClaudeChatWindow window : ClaudeSDKToolWindow.getAllWindows()) {
            var bridge = window.getClaudeSDKBridge();
            if (bridge != null) {
                bridge.setDiagnosticManager(enabled ? this : null);
            }
        }

        LOG.info("[DiagnosticManager] Set IPC sniffer enabled: " + enabled
                + " (propagated to " + ClaudeSDKToolWindow.getAllWindows().size() + " tabs)");

        JsonObject response = new JsonObject();
        response.addProperty("enabled", enabled);
        context.callJavaScript("window.updateIpcSnifferConfig", context.escapeJs(GSON.toJson(response)));
    }

    private void enableSniffer() {
        if (ipcSnifferWriter == null) {
            java.nio.file.Path dir = Paths.get(
                    PlatformUtils.getHomeDirectory(), ".codemoss", "diagnostics", "ipc-sniffer");
            ipcSnifferWriter = new IpcSnifferWriter(dir);
            LOG.info("[DiagnosticManager] IPC sniffer enabled, logging to: " + dir);
        }
        ipcSnifferEnabled = true;
    }

    private void disableSniffer() {
        LOG.info("[DiagnosticManager] IPC sniffer disabled");
        ipcSnifferEnabled = false;
        if (ipcSnifferWriter != null) {
            ipcSnifferWriter.shutdown();
            ipcSnifferWriter = null;
        }
    }
}
