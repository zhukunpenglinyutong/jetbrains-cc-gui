package com.github.claudecodegui.provider.common;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

/** Runs the production transport with an isolated daemon and a test-only native peer command. */
public final class CodexFixtureDaemon extends DaemonBridge {
    private final JsonArray peerCommand;

    /** Creates a real daemon process while keeping account paths isolated. */
    public CodexFixtureDaemon(Path repository, Path home, String scenario, Path trace,
                              AtomicReference<Process> process) throws IOException {
        super(null, null, null, TimeSource.system(), () -> {
            ProcessBuilder builder = new ProcessBuilder("node", repository.resolve("ai-bridge/daemon.js").toString());
            builder.directory(repository.resolve("ai-bridge").toFile());
            builder.environment().keySet().removeIf(key -> key.matches("(?i).*(API_KEY|TOKEN|SECRET|AUTHORIZATION).*"));
            builder.environment().put("HOME", home.toString());
            builder.environment().put("USERPROFILE", home.toString());
            builder.environment().put("CODEX_HOME", home.resolve("codex").toString());
            Process child = builder.start();
            process.set(child);
            return child;
        }, null);
        // Transport tests isolate HOME, but the isolated home has no config yet and
        // title generation then defaults on: its auxiliary RPCs and app-server child
        // race the transport assertions (e.g. "abort confirms process exit").
        Path codemoss = Files.createDirectories(home.resolve(".codemoss"));
        JsonObject isolatedConfig = new JsonObject();
        isolatedConfig.addProperty("aiTitleGenerationEnabled", false);
        Files.writeString(codemoss.resolve("config.json"), isolatedConfig.toString());
        this.peerCommand = new JsonArray();
        for (String argument : List.of("node", repository.resolve("ai-bridge/services/codex/testing/codex-stdio-peer.js").toString(),
                "--scenario", scenario, "--trace", trace.toString())) {
            this.peerCommand.add(argument);
        }
    }

    /** Adds the fixture command only inside test transport assembly. */
    @Override
    public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
        JsonObject isolated = params.deepCopy();
        isolated.add("codexCommandPrefix", this.peerCommand.deepCopy());
        return super.sendCommand(method, isolated, callback);
    }
}
