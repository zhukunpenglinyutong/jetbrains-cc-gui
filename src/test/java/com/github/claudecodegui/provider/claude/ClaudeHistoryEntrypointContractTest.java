package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Contract test for the {@code entrypoint} field that the history panel's SDK-to-CLI
 * conversion depends on.
 *
 * <p>The field travels through three representations that are NOT interchangeable:
 * <ul>
 *   <li>the JSONL row on disk, where it is a top-level string field;</li>
 *   <li>the index file, where {@code null} means "extraction never ran" and {@code ""}
 *       means "extraction ran, the file carries no entrypoint" (the two drive different
 *       branches of the incremental scan, so collapsing them loses the healing signal);</li>
 *   <li>the webview payload, where the field must be either the real entrypoint string
 *       or absent -- an empty string there is indistinguishable from a real value and
 *       makes the conversion button look permanently empty.</li>
 * </ul>
 *
 * <p>These tests pin that round-trip end to end (lite scan -> index persist -> index
 * restore -> Gson payload) so a future "simplification" cannot silently break it.
 */
public class ClaudeHistoryEntrypointContractTest {

    private static final String SDK_CLI_SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
    private static final String VSCODE_SESSION = "bbbbbbbb-2222-4222-8222-222222222222";
    private static final String PLAIN_SESSION = "cccccccc-3333-4333-8333-333333333333";

    @Rule
    public final TemporaryFolder tmp = new TemporaryFolder();

    private Path projectsDir;
    private String projectPath;
    private SessionIndexManager indexManager;

    @Before
    public void setUp() throws IOException {
        this.projectsDir = tmp.newFolder("claude-contract-projects").toPath();
        // A path that need not exist on disk: readProjectSessions only uses it to derive
        // the sanitized project directory key, so the test never touches the real ~/.claude.
        this.projectPath = tmp.getRoot().toPath().resolve("claude-contract-project").toString();
        this.indexManager = new SessionIndexManager(tmp.newFolder("claude-contract-index").toPath());
        SessionIndexCache.getInstance().clearProject(projectPath);
    }

    @After
    public void tearDown() {
        SessionIndexCache.getInstance().clearProject(projectPath);
        indexManager.clearProjectIndex("claude", projectPath);
    }

    @Test
    public void sdkCliEntryPoint_survivesIndexRoundTrip_andStaysStableOnRestore() throws IOException {
        Path projectDir = projectDir();
        writeSession(projectDir, SDK_CLI_SESSION, "Sdk created session", "sdk-cli");

        // First read scans the file and persists the index.
        assertEquals("sdk-cli", entrypointOf(newService().readProjectSessions(projectPath, 0, 0), SDK_CLI_SESSION));
        assertEquals("index must store the real entrypoint, never the empty marker",
                "sdk-cli", persistedEntrypoint(SDK_CLI_SESSION));

        // Second read is served by the index restore path. If the restore dropped or
        // nulled the field, the conversion button would go blank on the very next render.
        clearMemoryCache();
        assertEquals("sdk-cli", entrypointOf(newService().readProjectSessions(projectPath, 0, 0), SDK_CLI_SESSION));
        assertEquals("sdk-cli", persistedEntrypoint(SDK_CLI_SESSION));
    }

    @Test
    public void claudeVscodeEntryPoint_survivesIndexRoundTrip_andStaysStableOnRestore() throws IOException {
        Path projectDir = projectDir();
        writeSession(projectDir, VSCODE_SESSION, "VSCode created session", "claude-vscode");

        assertEquals("claude-vscode",
                entrypointOf(newService().readProjectSessions(projectPath, 0, 0), VSCODE_SESSION));
        assertEquals("claude-vscode", persistedEntrypoint(VSCODE_SESSION));

        clearMemoryCache();
        assertEquals("claude-vscode",
                entrypointOf(newService().readProjectSessions(projectPath, 0, 0), VSCODE_SESSION));
    }

    @Test
    public void sessionWithoutEntryPoint_isPersistedAsEmptyMarker_butRestoredAsNull() throws IOException {
        Path projectDir = projectDir();
        writeSession(projectDir, PLAIN_SESSION, "Plain cli session", null);

        assertNull("a file without an entrypoint must not invent one",
                entrypointOf(newService().readProjectSessions(projectPath, 0, 0), PLAIN_SESSION));
        assertEquals("\"\" is the persisted marker for \"extracted, file has none\"",
                "", persistedEntrypoint(PLAIN_SESSION));

        clearMemoryCache();
        assertNull("the empty marker must be surfaced as null, not as \"\"",
                entrypointOf(newService().readProjectSessions(projectPath, 0, 0), PLAIN_SESSION));
    }

    @Test
    public void mixedProject_keepsEachEntryPointIndependent() throws IOException {
        Path projectDir = projectDir();
        writeSession(projectDir, SDK_CLI_SESSION, "Sdk session", "sdk-cli");
        writeSession(projectDir, VSCODE_SESSION, "VSCode session", "claude-vscode");
        writeSession(projectDir, PLAIN_SESSION, "Plain session", null);

        List<ClaudeHistoryReader.SessionInfo> sessions = newService().readProjectSessions(projectPath, 0, 0);

        assertEquals(3, sessions.size());
        assertEquals("sdk-cli", entrypointOf(sessions, SDK_CLI_SESSION));
        assertEquals("claude-vscode", entrypointOf(sessions, VSCODE_SESSION));
        assertNull(entrypointOf(sessions, PLAIN_SESSION));
    }

    /**
     * Pins the wire contract with the webview: the field must arrive as the real string or
     * be absent, and must never arrive as an empty string. An empty string would be truthy
     * enough to look like data while matching no known entrypoint, hiding the reason the
     * conversion button is unavailable.
     */
    @Test
    public void webviewPayload_carriesRealEntrypoints_andNeverEmitsAnEmptyString() throws IOException {
        Path projectDir = projectDir();
        writeSession(projectDir, SDK_CLI_SESSION, "Sdk session", "sdk-cli");
        writeSession(projectDir, VSCODE_SESSION, "VSCode session", "claude-vscode");
        writeSession(projectDir, PLAIN_SESSION, "Plain session", null);

        Map<String, Object> payload = new HashMap<>();
        payload.put("success", true);
        payload.put("sessions", newService().readProjectSessions(projectPath, 0, 0));
        JsonObject json = JsonParser.parseString(new Gson().toJson(payload)).getAsJsonObject();
        JsonArray sessions = json.getAsJsonArray("sessions");

        assertEquals(3, sessions.size());
        for (JsonElement element : sessions) {
            JsonObject session = element.getAsJsonObject();
            JsonElement entrypoint = session.get("entrypoint");
            if (entrypoint == null) {
                // Absent is the correct representation of "no entrypoint": Gson omits nulls.
                assertFalse("entrypoint must never serialize as an empty string",
                        session.has("entrypoint") && session.get("entrypoint").getAsString().isEmpty());
                continue;
            }
            assertTrue("entrypoint must be a non-empty string when present",
                    entrypoint.getAsString().matches("sdk-cli|claude-vscode|cli"));
        }

        assertTrue("sdk-cli must be present in the payload",
                hasEntrypoint(sessions, SDK_CLI_SESSION, "sdk-cli"));
        assertTrue("claude-vscode must be present in the payload",
                hasEntrypoint(sessions, VSCODE_SESSION, "claude-vscode"));
        assertFalse("a session without an entrypoint must omit the field",
                sessions.get(findIndex(sessions, PLAIN_SESSION)).getAsJsonObject().has("entrypoint"));
    }

    private boolean hasEntrypoint(JsonArray sessions, String sessionId, String expected) {
        return expected.equals(sessions.get(findIndex(sessions, sessionId))
                .getAsJsonObject().get("entrypoint").getAsString());
    }

    private int findIndex(JsonArray sessions, String sessionId) {
        for (int i = 0; i < sessions.size(); i++) {
            if (sessionId.equals(sessions.get(i).getAsJsonObject().get("sessionId").getAsString())) {
                return i;
            }
        }
        throw new AssertionError("session " + sessionId + " missing from payload");
    }

    private String entrypointOf(List<ClaudeHistoryReader.SessionInfo> sessions, String sessionId) {
        return sessions.stream()
                .filter(s -> sessionId.equals(s.sessionId))
                .findFirst()
                .orElseThrow(() -> new AssertionError("session " + sessionId + " missing from result"))
                .entrypoint;
    }

    /**
     * Reads the persisted value straight out of the index file, bypassing every in-memory
     * representation, so the "" vs null distinction is asserted where it is actually stored.
     */
    private String persistedEntrypoint(String sessionId) {
        SessionIndexManager.ProjectIndex projectIndex = indexManager.readClaudeIndex().projects.get(projectPath);
        assertTrue("project missing from index", projectIndex != null);
        for (SessionIndexManager.SessionIndexEntry entry : projectIndex.sessions) {
            if (sessionId.equals(entry.sessionId)) {
                return entry.entrypoint;
            }
        }
        throw new AssertionError("session " + sessionId + " missing from index");
    }

    private void clearMemoryCache() {
        SessionIndexCache.getInstance().clearProject(projectPath);
    }

    private Path projectDir() throws IOException {
        return Files.createDirectories(projectsDir.resolve(PathUtils.getSanitizedPathCandidates(projectPath).get(0)));
    }

    private ClaudeHistoryIndexService newService() {
        return new ClaudeHistoryIndexService(projectsDir, new ClaudeHistoryParser(), indexManager);
    }

    private void writeSession(Path projectDir, String sessionId, String firstUserText, String entrypoint)
            throws IOException {
        StringBuilder row = new StringBuilder("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"")
                .append(firstUserText)
                .append("\"},\"timestamp\":\"2026-04-21T10:00:00Z\"");
        if (entrypoint != null) {
            // Real session files put entrypoint at the row top level, next to type/sessionId.
            row.append(",\"entrypoint\":\"").append(entrypoint).append("\"");
        }
        row.append("}\n");
        Files.writeString(projectDir.resolve(sessionId + ".jsonl"), row.toString());
    }
}
