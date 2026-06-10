package com.github.claudecodegui.util;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.stream.Stream;
import com.github.claudecodegui.util.GsonHolder;

/**
 * Appends plugin-generated Codex history events to ~/.codex/sessions JSONL files.
 */
public final class CodexHistoryWriter {

    private static final Logger LOG = Logger.getInstance(CodexHistoryWriter.class);
    private static final Path CODEX_SESSIONS_DIR = Paths.get(PlatformUtils.getHomeDirectory(), ".codex", "sessions");
    private static final Gson GSON = GsonHolder.GSON;

    private CodexHistoryWriter() {
    }

    public static boolean appendProviderError(String sessionId, String summary, String details, Integer exitCode) {
        return appendProviderError(sessionId, summary, details, exitCode, CODEX_SESSIONS_DIR);
    }

    static boolean appendProviderError(
            String sessionId,
            String summary,
            String details,
            Integer exitCode,
            Path sessionsDir
    ) {
        if (sessionId == null || sessionId.isBlank()) {
            LOG.debug("[CodexHistoryWriter] Skipping provider error append: sessionId is blank");
            return false;
        }
        if (details == null || details.isBlank()) {
            LOG.debug("[CodexHistoryWriter] Skipping provider error append: details is blank");
            return false;
        }

        try {
            Path sessionFile = findSessionFile(sessionId, sessionsDir);
            if (sessionFile == null) {
                LOG.debug("[CodexHistoryWriter] No Codex session file found for: " + sessionId);
                return false;
            }

            JsonObject line = new JsonObject();
            line.addProperty("timestamp", Instant.now().toString());
            line.addProperty("type", "provider_error");

            JsonObject payload = new JsonObject();
            payload.addProperty("provider", "codex");
            payload.addProperty("summary", normalizeSummary(summary, details));
            payload.addProperty("details", details);
            if (exitCode != null) {
                payload.addProperty("exitCode", exitCode);
            }
            line.add("payload", payload);

            Files.writeString(sessionFile, GSON.toJson(line) + "\n",
                    StandardCharsets.UTF_8,
                    StandardOpenOption.APPEND);
            LOG.info("[CodexHistoryWriter] Appended provider error to JSONL: " + sessionFile);
            return true;
        } catch (IOException e) {
            LOG.warn("[CodexHistoryWriter] Failed to append provider error: " + e.getMessage());
        } catch (Exception e) {
            LOG.warn("[CodexHistoryWriter] Unexpected provider error append failure: " + e.getMessage());
        }
        return false;
    }

    private static Path findSessionFile(String sessionId, Path sessionsDir) throws IOException {
        if (sessionsDir == null || !Files.exists(sessionsDir)) {
            return null;
        }
        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            return paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(".jsonl"))
                    .filter(path -> path.getFileName().toString().contains(sessionId))
                    .findFirst()
                    .orElse(null);
        }
    }

    private static String normalizeSummary(String summary, String details) {
        if (summary != null && !summary.isBlank()) {
            return summary;
        }
        String trimmed = details == null ? "" : details.trim();
        if (trimmed.length() <= 80) {
            return trimmed;
        }
        return trimmed.substring(0, 80) + "...";
    }
}
