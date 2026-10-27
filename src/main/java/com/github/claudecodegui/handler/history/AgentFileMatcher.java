package com.github.claudecodegui.handler.history;

import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Shared detection of legacy {@code agent-*.jsonl} files that belong to a session.
 *
 * <p>The fork copies these files under the new session id, and the delete path has
 * to recognize the copies again. Keeping a single implementation stops the two
 * sides from drifting apart.
 */
final class AgentFileMatcher {

    private static final Logger LOG = Logger.getInstance(AgentFileMatcher.class);

    /** Only the head of an agent transcript identifies its session; the rest is messages. */
    private static final int MAX_SCAN_LINES = 20;

    private AgentFileMatcher() {
    }

    /**
     * @param agentFilePath Candidate agent transcript.
     * @param sessionId Session id to match.
     * @return true when the file references the session in its first {@value #MAX_SCAN_LINES} lines.
     */
    static boolean isRelatedToSession(Path agentFilePath, String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            return false;
        }
        String sessionNeedle = "\"sessionId\":\"" + sessionId + "\"";
        String parentNeedle = "\"parentSessionId\":\"" + sessionId + "\"";
        try (BufferedReader reader = Files.newBufferedReader(agentFilePath, StandardCharsets.UTF_8)) {
            String line;
            int lineCount = 0;
            while ((line = reader.readLine()) != null && lineCount < MAX_SCAN_LINES) {
                if (line.contains(sessionNeedle) || line.contains(parentNeedle)) {
                    return true;
                }
                lineCount++;
            }
            return false;
        } catch (Exception e) {
            LOG.warn("[AgentFileMatcher] Failed to read agent file "
                    + agentFilePath.getFileName() + ": " + e.getMessage());
            return false;
        }
    }
}
