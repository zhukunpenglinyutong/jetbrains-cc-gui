package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Handles input history management messages.
 * Delegates to Node.js input-history-service.cjs for actual storage.
 */
public class InputHistoryHandler {

    private static final Logger LOG = Logger.getInstance(InputHistoryHandler.class);

    private final HandlerContext context;

    public InputHistoryHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Get input history records.
     */
    public void handleGetInputHistory() {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("getAllHistoryData", null);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryLoaded", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to get input history: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryLoaded", context.escapeJs("{\"items\":[],\"counts\":{}}"));
                });
            }
        });
    }

    /**
     * Record input history.
     * @param content JSON array of fragments
     */
    public void handleRecordInputHistory(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryServiceWithArray("recordHistory", content);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryRecorded", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to record input history: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Delete a single input history item.
     * @param content the history item to delete
     */
    public void handleDeleteInputHistoryItem(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("deleteHistoryItem", content);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryDeleted", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to delete input history item: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Clear all input history.
     */
    public void handleClearInputHistory() {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("clearAllHistory", null);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryCleared", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to clear input history: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Call Node.js input-history-service (single parameter version).
     */
    public String callInputHistoryService(String functionName, String param) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        String nodeScript;
        if (param == null || param.isEmpty()) {
            // Call without parameters
            nodeScript = String.format(
                "const { %s } = require('%s/services/input-history-service.cjs'); " +
                "const result = %s(); " +
                "console.log(JSON.stringify(result));",
                functionName,
                bridgePath.replace("\\", "\\\\"),
                functionName
            );
            return executeNodeScript(nodePath, nodeScript, null);
        } else {
            // Single parameter call (passed via stdin to avoid escaping issues)
            nodeScript = String.format(
                "const { %s } = require('%s/services/input-history-service.cjs'); " +
                "let input = ''; " +
                "process.stdin.on('data', chunk => input += chunk); " +
                "process.stdin.on('end', () => { " +
                "  try { " +
                "    const param = input.trim(); " +
                "    const result = %s(param); " +
                "    console.log(JSON.stringify(result)); " +
                "  } catch (err) { " +
                "    console.error(JSON.stringify({ error: err.message })); " +
                "    process.exit(1); " +
                "  } " +
                "});",
                functionName,
                bridgePath.replace("\\", "\\\\"),
                functionName
            );
            return executeNodeScript(nodePath, nodeScript, param);
        }
    }

    /**
     * Call Node.js input-history-service (array parameter version, used for recordHistory).
     */
    public String callInputHistoryServiceWithArray(String functionName, String jsonArrayParam) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Use stdin to pass JSON data, avoiding shell escaping issues with special characters
        String nodeScript = String.format(
            "const { %s } = require('%s/services/input-history-service.cjs'); " +
            "let input = ''; " +
            "process.stdin.on('data', chunk => input += chunk); " +
            "process.stdin.on('end', () => { " +
            "  try { " +
            "    const data = JSON.parse(input); " +
            "    const result = %s(data); " +
            "    console.log(JSON.stringify(result)); " +
            "  } catch (err) { " +
            "    console.error(JSON.stringify({ error: err.message })); " +
            "    process.exit(1); " +
            "  } " +
            "});",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName
        );

        return executeNodeScript(nodePath, nodeScript, jsonArrayParam);
    }

    /**
     * Execute a Node.js script, optionally writing stdinData to the process stdin.
     * Handles process creation, stdin write, stdout read, 30s timeout, and exit code check.
     *
     * @param nodePath   path to the node executable
     * @param nodeScript the JavaScript code to run via node -e
     * @param stdinData  data to write to stdin, or null to skip stdin write
     * @return the last non-empty line of stdout
     */
    private String executeNodeScript(String nodePath, String nodeScript, String stdinData) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        if (stdinData != null) {
            try (BufferedWriter writer = new BufferedWriter(
                    new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8))) {
                writer.write(stdinData);
                writer.flush();
            }
        }

        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        boolean finished = process.waitFor(30, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new Exception("Node.js process timeout after 30 seconds");
        }

        int exitCode = process.exitValue();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output);
        }

        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }
}
