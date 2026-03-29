package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Reads persisted Claude session history via the Node bridge.
 */
class ClaudeSessionQueryService {

    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final int PROCESS_TIMEOUT_SECONDS = 30;
    private static final java.util.regex.Pattern VALID_SESSION_ID = java.util.regex.Pattern.compile("[a-zA-Z0-9_\\-]+");

    private final Logger log;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeSessionQueryService(
            Logger log,
            Gson gson,
            NodeDetector nodeDetector,
            Supplier<File> sdkDirSupplier,
            EnvironmentConfigurator envConfigurator,
            ClaudeJsonOutputExtractor outputExtractor
    ) {
        this.log = log;
        this.gson = gson;
        this.nodeDetector = nodeDetector;
        this.sdkDirSupplier = sdkDirSupplier;
        this.envConfigurator = envConfigurator;
        this.outputExtractor = outputExtractor;
    }

    List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            JsonObject jsonResult = runSessionQuery("getSession", sessionId, cwd, "getSessionMessages");

            if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                List<JsonObject> messages = new ArrayList<>();
                if (jsonResult.has("messages")) {
                    JsonArray messagesArray = jsonResult.getAsJsonArray("messages");
                    for (var msg : messagesArray) {
                        messages.add(msg.getAsJsonObject());
                    }
                }
                return messages;
            }

            String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                    ? jsonResult.get("error").getAsString()
                    : "Unknown error";
            throw new RuntimeException("Get session failed: " + errorMsg);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Failed to get session messages: " + e.getMessage(), e);
        }
    }

    JsonObject getLatestUserMessage(String sessionId, String cwd) {
        try {
            JsonObject jsonResult = runSessionQuery("getLatestUserMessage", sessionId, cwd, "getLatestUserMessage");

            if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                if (jsonResult.has("message") && jsonResult.get("message").isJsonObject()) {
                    return jsonResult.getAsJsonObject("message");
                }
                return null;
            }

            String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                    ? jsonResult.get("error").getAsString()
                    : "Unknown error";
            throw new RuntimeException("Get latest user message failed: " + errorMsg);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Failed to get latest user message: " + e.getMessage(), e);
        }
    }

    private JsonObject runSessionQuery(String commandName, String sessionId, String cwd, String logPrefix) throws Exception {
        if (sessionId == null || !VALID_SESSION_ID.matcher(sessionId).matches()) {
            throw new IllegalArgumentException("Invalid sessionId: " + sessionId);
        }

        String node = nodeDetector.findNodeExecutable();

        File workDir = sdkDirSupplier.get();
        if (workDir == null || !workDir.exists()) {
            throw new RuntimeException("Bridge directory not ready or invalid");
        }

        List<String> command = new ArrayList<>();
        command.add(node);
        command.add(CHANNEL_SCRIPT);
        command.add("claude");
        command.add(commandName);
        command.add(sessionId);
        command.add(cwd != null ? cwd : "");

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(workDir);
        pb.redirectErrorStream(true);
        envConfigurator.updateProcessEnvironment(pb, node);

        Process process = pb.start();

        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        boolean finished = process.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new RuntimeException("Node.js process timed out after " + PROCESS_TIMEOUT_SECONDS + " seconds");
        }

        String outputStr = output.toString().trim();
        log.debug("[" + logPrefix + "] Raw output length: " + outputStr.length());
        if (log.isDebugEnabled()) {
            log.debug("[" + logPrefix + "] Raw output (first 300 chars): "
                    + (outputStr.length() > 300 ? outputStr.substring(0, 300) + "..." : outputStr));
        }

        String jsonStr = outputExtractor.extractLastJsonLine(outputStr);
        if (jsonStr == null) {
            log.error("[" + logPrefix + "] Failed to extract JSON from output");
            throw new RuntimeException("Failed to extract JSON from Node.js output");
        }

        if (log.isDebugEnabled()) {
            log.debug("[" + logPrefix + "] Extracted JSON: "
                    + (jsonStr.length() > 500 ? jsonStr.substring(0, 500) + "..." : jsonStr));
        }
        JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
        log.debug("[" + logPrefix + "] JSON parsed successfully, success="
                + (jsonResult.has("success") ? jsonResult.get("success").getAsBoolean() : "null"));
        return jsonResult;
    }
}
