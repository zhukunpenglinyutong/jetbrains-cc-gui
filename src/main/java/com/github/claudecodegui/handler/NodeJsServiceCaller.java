package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.NodeProcessRunner;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;

import java.util.List;
import java.util.Set;

/**
 * Handles Node.js subprocess calls for favorites and session titles services.
 * <p>
 * Extracted from HistoryHandler to encapsulate all Node.js process invocation logic
 * for favorites-service.cjs and session-titles-service.cjs.
 */
public class NodeJsServiceCaller {

    private static final int PROCESS_TIMEOUT_SECONDS = 30;
    private static final Gson GSON = new Gson();

    private static final Set<String> ALLOWED_FAVORITES_FUNCTIONS = Set.of(
        "loadFavorites", "toggleFavorite", "removeFavorite"
    );

    private static final Set<String> ALLOWED_TITLES_FUNCTIONS = Set.of(
        "loadTitles", "updateTitle", "deleteTitle"
    );

    // Every write rewrites the whole favorites.json / session-titles.json, so
    // overlapping calls (e.g. deleting one session while renaming another) lose
    // updates. JVM-wide: each chat window has its own caller, the files are shared.
    private static final Object FAVORITES_FILE_LOCK = new Object();
    private static final Object TITLES_FILE_LOCK = new Object();

    private final HandlerContext context;
    private final int processTimeoutSeconds;

    public NodeJsServiceCaller(HandlerContext context) {
        this(context, PROCESS_TIMEOUT_SECONDS);
    }

    NodeJsServiceCaller(HandlerContext context, int processTimeoutSeconds) {
        this.context = context;
        this.processTimeoutSeconds = processTimeoutSeconds;
    }

    /**
     * Call Node.js favorites-service.
     */
    public String callNodeJsFavoritesService(String functionName, String sessionId) throws Exception {
        validateFunctionName(functionName, ALLOWED_FAVORITES_FUNCTIONS);

        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "favorites-service.cjs");

        String nodeScript = String.format(
            "const { %s } = require(process.argv[1]); " +
            "const result = %s(process.env.SESSION_ID); " +
            "console.log(JSON.stringify(result));",
            functionName,
            functionName
        );

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);
        pb.environment().put("SESSION_ID", sessionId);

        return executeLocked(FAVORITES_FILE_LOCK, pb);
    }

    /**
     * Call Node.js session-titles-service (no-argument version, for loadTitles).
     */
    public String callNodeJsTitlesService(String functionName) throws Exception {
        validateFunctionName(functionName, ALLOWED_TITLES_FUNCTIONS);

        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "session-titles-service.cjs");

        String nodeScript = String.format(
            "const { %s } = require(process.argv[1]); " +
            "const result = %s(); " +
            "console.log(JSON.stringify(result));",
            functionName,
            functionName
        );

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);

        return executeLocked(TITLES_FILE_LOCK, pb);
    }

    /**
     * Call Node.js session-titles-service (with parameters, for updateTitle).
     */
    public String callNodeJsTitlesServiceWithParams(String functionName, String sessionId, String customTitle) throws Exception {
        validateFunctionName(functionName, ALLOWED_TITLES_FUNCTIONS);

        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "session-titles-service.cjs");

        String nodeScript = String.format(
            "const { %s } = require(process.argv[1]); " +
            "const result = %s(process.env.SESSION_ID, process.env.CUSTOM_TITLE); " +
            "console.log(JSON.stringify(result));",
            functionName,
            functionName
        );

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);
        pb.environment().put("SESSION_ID", sessionId);
        pb.environment().put("CUSTOM_TITLE", customTitle);

        return executeLocked(TITLES_FILE_LOCK, pb);
    }

    /**
     * Call Node.js session-titles-service to delete a title (single parameter version).
     */
    public String callNodeJsDeleteTitle(String sessionId) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "session-titles-service.cjs");

        String nodeScript =
            "const { deleteTitle } = require(process.argv[1]); " +
            "const result = deleteTitle(process.env.SESSION_ID); " +
            "console.log(JSON.stringify({ success: result }));";

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);
        pb.environment().put("SESSION_ID", sessionId);

        return executeLocked(TITLES_FILE_LOCK, pb);
    }

    /**
     * Remove the favorites of several sessions in one Node process.
     *
     * @param sessionIds the deleted sessions
     * @return {@code true} or {@code false} as printed by {@code removeFavorites}
     */
    public String callNodeJsRemoveFavorites(List<String> sessionIds) throws Exception {
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath,
                context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath(), "favorites-service.cjs");
        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, batchScript("removeFavorites", "result"), servicePath);
        pb.redirectErrorStream(true);
        return executeLocked(FAVORITES_FILE_LOCK, pb, GSON.toJson(sessionIds));
    }

    /**
     * Delete the custom titles of several sessions in one Node process.
     *
     * @param sessionIds the deleted sessions
     * @return {@code {"success":true|false}}
     */
    public String callNodeJsDeleteTitles(List<String> sessionIds) throws Exception {
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath,
                context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath(), "session-titles-service.cjs");
        ProcessBuilder pb = buildNodeProcessBuilder(nodePath,
                batchScript("deleteTitles", "{ success: result }"), servicePath);
        pb.redirectErrorStream(true);
        return executeLocked(TITLES_FILE_LOCK, pb, GSON.toJson(sessionIds));
    }

    /**
     * Inline script that reads a JSON array of session ids from stdin. Stdin carries any batch
     * size (an environment variable is capped at 32 KiB on Windows) and also reaches WSL node.
     */
    private static String batchScript(String functionName, String printedExpression) {
        return "const { " + functionName + " } = require(process.argv[1]); "
                + "let input = ''; "
                + "process.stdin.setEncoding('utf8'); "
                + "process.stdin.on('data', chunk => input += chunk); "
                + "process.stdin.on('end', () => { "
                + "  const result = " + functionName + "(JSON.parse(input)); "
                + "  console.log(JSON.stringify(" + printedExpression + ")); "
                + "});";
    }

    /**
     * Build a ProcessBuilder for running a Node.js inline script.
     * Delegates to {@link NodeDetector#buildNodeInlineCommand} so WSL prefixing is centralised.
     */
    private ProcessBuilder buildNodeProcessBuilder(String nodePath, String nodeScript, String servicePath) {
        List<String> command = NodeDetector.buildNodeInlineCommand(nodePath, nodeScript);
        command.add(servicePath);
        return new ProcessBuilder(command);
    }

    private String executeLocked(Object fileLock, ProcessBuilder pb) throws Exception {
        return executeLocked(fileLock, pb, null);
    }

    private String executeLocked(Object fileLock, ProcessBuilder pb, String stdinData) throws Exception {
        synchronized (fileLock) {
            return executeNodeScript(pb, stdinData);
        }
    }

    static String resolveServicePath(String nodePath, String bridgePath, String serviceFileName) {
        String servicePath = bridgePath + "/services/" + serviceFileName;
        return NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(servicePath) : servicePath;
    }

    /**
     * Validate that the function name is in the allowed set to prevent injection.
     */
    private void validateFunctionName(String functionName, Set<String> allowedFunctions) {
        if (functionName == null || !allowedFunctions.contains(functionName)) {
            throw new IllegalArgumentException(
                "Invalid function name: " + functionName + ". Allowed: " + allowedFunctions
            );
        }
    }

    /**
     * Execute a Node.js script under a hard timeout and return the last line of
     * stdout (expected to be JSON). See {@link NodeProcessRunner} for how the
     * deadline is enforced.
     */
    String executeNodeScript(ProcessBuilder pb) throws Exception {
        return executeNodeScript(pb, null);
    }

    private String executeNodeScript(ProcessBuilder pb, String stdinData) throws Exception {
        // L8 fix: register with ProcessManager so cleanupAllProcesses sees this child.
        ProcessManager processManager = context.getClaudeSDKBridge().getProcessManager();
        NodeProcessRunner.Result result =
                NodeProcessRunner.run(pb, processManager, "node-service", stdinData, processTimeoutSeconds);
        if (result.exitCode() != 0) {
            throw new Exception("Node.js process exited with code " + result.exitCode() + ": " + result.output());
        }
        return result.lastLine();
    }
}
