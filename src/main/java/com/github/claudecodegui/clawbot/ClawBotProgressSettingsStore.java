package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Objects;

/** Persists the shared, non-sensitive Claw Bot progress intervals. */
final class ClawBotProgressSettingsStore {

    private static final String FILE_NAME = "progress-settings.json";
    private static final long MAX_FILE_SIZE = 16L * 1024L;

    private final Path settingsFile;

    ClawBotProgressSettingsStore(Path runtimeDirectory) {
        settingsFile = Objects.requireNonNull(runtimeDirectory, "runtimeDirectory")
                .toAbsolutePath().normalize().resolve(FILE_NAME);
    }

    synchronized ClawBotProgressSettings load() throws IOException {
        if (!Files.exists(settingsFile, LinkOption.NOFOLLOW_LINKS)) {
            return ClawBotProgressSettings.defaults();
        }
        if (!Files.isRegularFile(settingsFile, LinkOption.NOFOLLOW_LINKS)
                || Files.size(settingsFile) > MAX_FILE_SIZE) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID");
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(settingsFile, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) {
                throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID");
            }
            return ClawBotProgressSettings.fromJson(parsed.getAsJsonObject());
        } catch (JsonParseException | IllegalArgumentException | IllegalStateException error) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID", error);
        }
    }

    synchronized void save(ClawBotProgressSettings settings) throws IOException {
        Objects.requireNonNull(settings, "settings");
        Files.createDirectories(settingsFile.getParent());
        Path temporary = Files.createTempFile(settingsFile.getParent(), "progress-settings-", ".tmp");
        try {
            Files.writeString(temporary, settings.toJson().toString(), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, settingsFile, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, settingsFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}
