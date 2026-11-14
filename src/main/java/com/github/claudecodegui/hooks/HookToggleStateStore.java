package com.github.claudecodegui.hooks;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

/** Persists CCGUI-managed disabled hooks outside provider active configuration. */
public final class HookToggleStateStore {

    private static final Logger LOG = Logger.getInstance(HookToggleStateStore.class);
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().serializeNulls().create();
    private static final String STATE_FILE_NAME = ".ccgui-hooks-state.json";

    private final Path userHome;
    private final Path stateFile;

    public HookToggleStateStore(Path userHome, Path providerDirectory) {
        this.userHome = userHome.toAbsolutePath().normalize();
        this.stateFile = HookLocalStorage.directory(this.userHome, "state", providerDirectory).resolve(STATE_FILE_NAME);
    }

    public Path getStateFile() {
        return stateFile;
    }

    public JsonObject read() {
        try {
            return readStrict();
        } catch (IOException | RuntimeException e) {
            LOG.warn("[HookToggle] Failed to read state file: " + stateFile, e);
            return emptyState();
        }
    }

    public JsonObject readStrict() throws IOException {
        Path readable = stateFile;
        if (!Files.exists(readable, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            return emptyState();
        }
        if (!Files.isRegularFile(readable) || Files.isSymbolicLink(readable) || Files.size(readable) > 1024L * 1024L) {
            throw new IOException("Invalid Hook toggle state file");
        }
        try {
            JsonObject state = JsonParser.parseString(Files.readString(readable, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            if (!state.has("schemaVersion") || state.get("schemaVersion").getAsInt() != 1
                    || !state.has("disabledClaude") || !state.get("disabledClaude").isJsonArray()) {
                throw new IOException("Unsupported Hook toggle state schema");
            }
            return state;
        } catch (RuntimeException e) {
            throw new IOException("Invalid Hook toggle state JSON", e);
        }
    }

    public void write(JsonObject state) throws IOException {
        HookLocalStorage.prepare(userHome, stateFile.getParent());
        Path temporary = Files.createTempFile(stateFile.getParent(), ".ccgui-hooks-state-", ".tmp");
        try {
            Files.writeString(temporary, GSON.toJson(state), StandardCharsets.UTF_8,
                    StandardOpenOption.TRUNCATE_EXISTING);
            HookLocalStorage.restrictFile(temporary);
            try {
                Files.move(temporary, stateFile, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                Files.move(temporary, stateFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    public static JsonObject emptyState() {
        JsonObject state = new JsonObject();
        state.addProperty("schemaVersion", 1);
        state.add("disabledClaude", new JsonArray());
        return state;
    }

}
