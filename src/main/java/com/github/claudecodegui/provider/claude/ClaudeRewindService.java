package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Executes Claude file rewind commands.
 */
class ClaudeRewindService {

    private static final String CHANNEL_SCRIPT = "channel-manager.js";

    private final Logger log;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final ProcessManager processManager;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeRewindService(
            Logger log,
            Gson gson,
            NodeDetector nodeDetector,
            Supplier<File> sdkDirSupplier,
            ProcessManager processManager,
            EnvironmentConfigurator envConfigurator,
            ClaudeJsonOutputExtractor outputExtractor
    ) {
        this.log = log;
        this.gson = gson;
        this.nodeDetector = nodeDetector;
        this.sdkDirSupplier = sdkDirSupplier;
        this.processManager = processManager;
        this.envConfigurator = envConfigurator;
        this.outputExtractor = outputExtractor;
    }

    CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId, String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            JsonObject response = new JsonObject();

            try {
                String node = nodeDetector.findNodeExecutable();
                File workDir = sdkDirSupplier.get();
                if (workDir == null || !workDir.exists()) {
                    response.addProperty("success", false);
                    response.addProperty("error", "Bridge directory not ready or invalid");
                    return response;
                }

                log.info("[Rewind] Starting rewind operation");
                log.info("[Rewind] Session ID: " + sessionId);
                log.info("[Rewind] Target message ID: " + userMessageId);

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("sessionId", sessionId);
                stdinInput.addProperty("userMessageId", userMessageId);
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(workDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");
                command.add("rewindFiles");

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(ClaudeBridgeUtils.resolveWorkingDirectory(workDir, cwd));
                pb.redirectErrorStream(true);

                Map<String, String> env = pb.environment();
                envConfigurator.configureProjectPath(env, cwd);
                File processTempDir = processManager.prepareClaudeTempDir();
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CLAUDE_USE_STDIN", "true");
                envConfigurator.updateProcessEnvironment(pb, node);

                Process process = pb.start();
                log.info("[Rewind] Process started, PID: " + process.pid());

                ClaudeBridgeUtils.writeStdin(stdinJson, process);

                CompletableFuture<String> outputFuture = CompletableFuture.supplyAsync(() -> {
                    StringBuilder output = new StringBuilder();
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            log.info("[Rewind] Output: " + line);
                            output.append(line).append("\n");
                        }
                    } catch (Exception ignored) {
                    }
                    return output.toString();
                });

                boolean finished = process.waitFor(60, TimeUnit.SECONDS);
                int exitCode;
                if (!finished) {
                    PlatformUtils.terminateProcess(process);
                    exitCode = -1;
                } else {
                    exitCode = process.exitValue();
                }
                log.info("[Rewind] Process exited with code: " + exitCode);

                String outputStr;
                try {
                    outputStr = outputFuture.get(5, TimeUnit.SECONDS).trim();
                } catch (Exception e) {
                    outputStr = "";
                }

                String jsonStr = outputExtractor.extractLastJsonLine(outputStr);
                if (jsonStr != null) {
                    try {
                        return gson.fromJson(jsonStr, JsonObject.class);
                    } catch (Exception e) {
                        log.warn("[Rewind] Failed to parse JSON: " + e.getMessage());
                    }
                }

                response.addProperty("success", exitCode == 0);
                if (exitCode != 0) {
                    response.addProperty("error", !finished
                            ? "Rewind process timeout"
                            : "Process exited with code: " + exitCode);
                }
                return response;
            } catch (Exception e) {
                log.error("[Rewind] Exception: " + e.getMessage(), e);
                response.addProperty("success", false);
                response.addProperty("error", e.getMessage());
                return response;
            }
        });
    }

}
