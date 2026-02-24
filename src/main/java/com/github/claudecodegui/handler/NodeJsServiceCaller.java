package com.github.claudecodegui.handler;

/**
 * Handles Node.js subprocess calls for favorites and session titles services.
 * <p>
 * Extracted from HistoryHandler to encapsulate all Node.js process invocation logic
 * for favorites-service.cjs and session-titles-service.cjs.
 */
public class NodeJsServiceCaller {

    private final HandlerContext context;

    public NodeJsServiceCaller(HandlerContext context) {
        this.context = context;
    }

    /**
     * Call Node.js favorites-service.
     */
    public String callNodeJsFavoritesService(String functionName, String sessionId) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Build Node.js command
        String nodeScript = String.format(
            "const { %s } = require('%s/services/favorites-service.cjs'); " +
            "const result = %s('%s'); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName,
            sessionId
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Call Node.js session-titles-service (no-argument version, for loadTitles).
     */
    public String callNodeJsTitlesService(String functionName, String dummy1, String dummy2) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Build Node.js command (loadTitles requires no arguments)
        String nodeScript = String.format(
            "const { %s } = require('%s/services/session-titles-service.cjs'); " +
            "const result = %s(); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Call Node.js session-titles-service (with parameters, for updateTitle).
     */
    public String callNodeJsTitlesServiceWithParams(String functionName, String sessionId, String customTitle) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Escape special characters
        String escapedTitle = customTitle.replace("\\", "\\\\").replace("'", "\\'");

        // Build Node.js command
        String nodeScript = String.format(
            "const { %s } = require('%s/services/session-titles-service.cjs'); " +
            "const result = %s('%s', '%s'); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName,
            sessionId,
            escapedTitle
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Call Node.js session-titles-service to delete a title (single parameter version).
     */
    public String callNodeJsDeleteTitle(String sessionId) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Build Node.js command
        String nodeScript = String.format(
            "const { deleteTitle } = require('%s/services/session-titles-service.cjs'); " +
            "const result = deleteTitle('%s'); " +
            "console.log(JSON.stringify({ success: result }));",
            bridgePath.replace("\\", "\\\\"),
            sessionId.replace("\\", "\\\\").replace("'", "\\'")
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }
}
