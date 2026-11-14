package com.github.claudecodegui.testing;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Set;

/**
 * Temporary ai-bridge directory holding the real {@code favorites-service.cjs}
 * and {@code session-titles-service.cjs}, so tests exercise the shipped JS
 * through {@code NodeJsServiceCaller} end to end.
 *
 * <p>{@code utils/path-utils.cjs} is replaced with a stub that points
 * {@code getCodemossDir()} at a sibling folder inside the fixture, so the
 * services never touch the developer's real {@code ~/.codemoss}.
 */
public final class SessionMetadataBridgeFixture {

    private static final Path REAL_SERVICES_DIR = Paths.get("ai-bridge", "services");
    private static final List<String> SERVICES = List.of(
            "favorites-service.cjs", "session-titles-service.cjs");

    private final Path dataDir;
    private final ProcessManager processManager = new ProcessManager();
    private final HandlerContext context;

    private SessionMetadataBridgeFixture(Path bridgeDir, Path dataDir) {
        this.dataDir = dataDir;
        StubClaudeSDKBridge sdkBridge = new StubClaudeSDKBridge(bridgeDir.toFile(), processManager);
        this.context = new HandlerContext(null, sdkBridge, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    public static SessionMetadataBridgeFixture create(Path root) throws IOException {
        Path bridgeDir = root.resolve("bridge");
        Path servicesDir = Files.createDirectories(bridgeDir.resolve("services"));
        Path utilsDir = Files.createDirectories(bridgeDir.resolve("utils"));
        Path dataDir = Files.createDirectories(root.resolve("codemoss"));

        for (String service : SERVICES) {
            Files.copy(REAL_SERVICES_DIR.resolve(service), servicesDir.resolve(service));
        }
        // bridge/utils/../../codemoss == <root>/codemoss
        Files.writeString(utilsDir.resolve("path-utils.cjs"),
                "const path = require('path');\n"
                        + "module.exports = {"
                        + " getCodemossDir: () => path.join(__dirname, '..', '..', 'codemoss')"
                        + " };\n",
                StandardCharsets.UTF_8);
        return new SessionMetadataBridgeFixture(bridgeDir, dataDir);
    }

    public HandlerContext context() {
        return context;
    }

    public ProcessManager processManager() {
        return processManager;
    }

    public void seedFavorites(String... sessionIds) throws IOException {
        JsonObject favorites = new JsonObject();
        for (String sessionId : sessionIds) {
            JsonObject entry = new JsonObject();
            entry.addProperty("favoritedAt", 1L);
            favorites.add(sessionId, entry);
        }
        Files.writeString(favoritesFile(), favorites.toString(), StandardCharsets.UTF_8);
    }

    public void seedTitles(String... sessionIds) throws IOException {
        JsonObject titles = new JsonObject();
        for (String sessionId : sessionIds) {
            JsonObject entry = new JsonObject();
            entry.addProperty("customTitle", "Title " + sessionId);
            entry.addProperty("updatedAt", 1L);
            titles.add(sessionId, entry);
        }
        Files.writeString(titlesFile(), titles.toString(), StandardCharsets.UTF_8);
    }

    public Set<String> favoriteIds() throws IOException {
        return readKeys(favoritesFile());
    }

    public Set<String> titledSessionIds() throws IOException {
        return readKeys(titlesFile());
    }

    private Path favoritesFile() {
        return dataDir.resolve("favorites.json");
    }

    private Path titlesFile() {
        return dataDir.resolve("session-titles.json");
    }

    private static Set<String> readKeys(Path file) throws IOException {
        if (!Files.exists(file)) {
            return Set.of();
        }
        String json = Files.readString(file, StandardCharsets.UTF_8);
        return Set.copyOf(JsonParser.parseString(json).getAsJsonObject().keySet());
    }

    private static final class StubClaudeSDKBridge extends ClaudeSDKBridge {
        private final File sdkDir;
        private final ProcessManager processManager;

        private StubClaudeSDKBridge(File sdkDir, ProcessManager processManager) {
            this.sdkDir = sdkDir;
            this.processManager = processManager;
        }

        @Override
        public File getSdkTestDir() {
            return sdkDir;
        }

        @Override
        public String getNodeExecutable() {
            return "node";
        }

        @Override
        public ProcessManager getProcessManager() {
            return processManager;
        }
    }
}
