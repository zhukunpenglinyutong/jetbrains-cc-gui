package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.session.SessionProviderRouter;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Contract tests for the Gemini marker bridge (Story 1.2).
 *
 * <p>The provider id and stdin env key are load-bearing across the stack:
 * {@link SessionProviderRouter} routes on the provider id and the Node side
 * ({@code ai-bridge/utils/stdin-utils.js STDIN_ENV_BY_PROVIDER}) switches JSON
 * stdin mode on the env key. A mismatch on either silently breaks every send.
 */
public class GeminiCliBridgeTest {

    @Test
    public void providerIdIsGeminiAndRegisteredAsCliProvider() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        assertEquals("gemini", bridge.providerId());
        assertTrue(
                "gemini must be routed as a headless CLI provider",
                SessionProviderRouter.isCliProvider("gemini"));
    }

    @Test
    public void stdinEnvKeyMatchesNodeStdinUtilsMap() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        // ai-bridge/utils/stdin-utils.js STDIN_ENV_BY_PROVIDER.gemini
        assertEquals("GEMINI_USE_STDIN", bridge.getStdinEnvKey());
    }

    @Test
    public void extendsMarkerCliBridgeForSharedMarkerParsing() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        assertTrue(bridge instanceof MarkerCliBridge);
    }

    @Test
    public void historyReaderDelegatesToGeminiHistoryReader() throws Exception {
        // The Story-1.2 empty-list stub is gone: the bridge must route history loads
        // through GeminiHistoryReader. A fixture database is injected via the test
        // constructor because the default home is the user's real CLI storage.
        org.junit.rules.TemporaryFolder home = new org.junit.rules.TemporaryFolder();
        home.create();
        try {
            String conversationId = "55555555-5555-4555-8555-555555555555";
            Path conversations = home.newFolder("conversations").toPath();
            Files.createDirectories(conversations);
            Path db = conversations.resolve(conversationId + ".db");
            try (java.sql.Connection conn = java.sql.DriverManager.getConnection(
                    "jdbc:sqlite:" + db.toAbsolutePath());
                 java.sql.Statement statement = conn.createStatement()) {
                statement.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT, "
                        + "status TEXT, step_payload BLOB, error_details TEXT)");
                byte[] payload = flatUserPayload("loaded through the bridge");
                try (java.sql.PreparedStatement insert = conn.prepareStatement(
                        "INSERT INTO steps (idx, step_type, status, step_payload) "
                                + "VALUES (0, 'user', 'done', ?)")) {
                    insert.setBytes(1, payload);
                    insert.executeUpdate();
                }
            }
            GeminiHistoryReader reader = new GeminiHistoryReader(
                    home.getRoot().toPath(), new com.google.gson.Gson());
            GeminiCliBridge bridge = new GeminiCliBridge(reader);

            List<com.google.gson.JsonObject> messages =
                    bridge.getSessionMessages(conversationId, "/tmp");
            assertEquals(1, messages.size());
            assertEquals("user", messages.get(0).get("type").getAsString());
        } finally {
            home.delete();
        }
    }

    @Test
    public void historyLoadRefusesIdsOutsideTheSharedWhitelist() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        List<com.google.gson.JsonObject> messages = bridge.getSessionMessages("../evil", "/tmp");
        assertTrue(messages.isEmpty());
    }

    /** One length-delimited protobuf field: {@code (field << 3) | 2, varint len, utf8}. */
    private static byte[] flatUserPayload(String text) {
        byte[] utf8 = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        long tag = (1L << 3) | 2;
        while ((tag & ~0x7FL) != 0) {
            out.write((int) ((tag & 0x7F) | 0x80));
            tag >>>= 7;
        }
        out.write((int) tag);
        out.write(utf8.length);
        out.writeBytes(utf8);
        return out.toByteArray();
    }

    @Test
    public void registrationMakesGeminiResolvableThroughTheRouter() {
        // Registration observability: if the gemini bridge stops being registered
        // (ClaudeChatWindow → SessionProviderRouter.registerCliBridges), sends
        // for provider "gemini" fall into the "no CLI bridge" rejection path and
        // every turn fails. This test fails the build the moment the router map
        // no longer resolves the provider id.
        java.util.Map<String, MarkerCliBridge> bridges =
                SessionProviderRouter.registerCliBridges(new GeminiCliBridge());
        assertTrue(
                "registerCliBridges must key the router map by the gemini provider id",
                bridges.containsKey("gemini"));
        assertTrue(bridges.get("gemini") instanceof GeminiCliBridge);
        assertTrue(SessionProviderRouter.isCliProvider("gemini"));
    }

    @Test
    public void stdinPayloadCarriesGuardedCwdAndPreClampRequestedCwd() {
        // BS-1: Java clamps cwd BEFORE the bridge, which erases the
        // requested-vs-used difference the Node substitution notice needs. The
        // stdin payload must therefore carry both values.
        com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                "hello", "sess-1", "/proj/base", "", "medium",
                java.util.Collections.emptyList(), "default", null, "/unsafe/requested");

        assertEquals("/proj/base", payload.get("cwd").getAsString());
        assertEquals("/unsafe/requested", payload.get("requestedCwd").getAsString());
        assertEquals("hello", payload.get("message").getAsString());
        assertEquals("default", payload.get("permissionMode").getAsString());
        // Story 1.3 AC1 (review patch): a known conversation id must round-trip
        // into the stdin payload unchanged — the resume half of AC1 at the Java
        // boundary (the Node side maps a non-empty sessionId to --conversation).
        assertEquals("sess-1", payload.get("sessionId").getAsString());
    }

    @Test
    public void stdinPayloadOmitsRequestedCwdWhenAbsent() {
        // Providers/services that don't use the field must not see a blank key.
        com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                "hello", "", "/proj/base", "", "medium",
                java.util.Collections.emptyList(), "default", null, null);
        assertTrue(!payload.has("requestedCwd"));

        com.google.gson.JsonObject blank = MarkerCliBridge.buildCliStdinPayload(
                "hello", "", "/proj/base", "", "medium",
                java.util.Collections.emptyList(), "default", null, "   ");
        assertTrue(!blank.has("requestedCwd"));
    }

    /** Exposes the protected marker-line router for protocol contract tests. */
    private static final class RoutingBridge extends GeminiCliBridge {
        void route(String line, com.github.claudecodegui.provider.common.MessageCallback callback) {
            processOutputLine(
                    line,
                    callback,
                    new com.github.claudecodegui.provider.common.SDKResult(),
                    new StringBuilder(),
                    new java.util.concurrent.atomic.AtomicBoolean(false),
                    new java.util.concurrent.atomic.AtomicReference<>(null));
        }
    }

    @Test
    public void sessionMarkerLineRoutesToTheSessionIdEvent() {
        // Story 1.3 Task 1: the CLI's conversation id reaches Java through the
        // shared marker protocol — MarkerCliBridge must translate a
        // "[SESSION_ID] <uuid>" line into the provider-neutral "session_id"
        // event the message handler stores on the session slot. (Node-side
        // emission of the marker is pinned by message-service.test.js.)
        RoutingBridge bridge = new RoutingBridge();
        List<String> types = new java.util.ArrayList<>();
        List<String> payloads = new java.util.ArrayList<>();

        bridge.route("[SESSION_ID] d5451c2b-751a-4248-9d75-47344e4bc885",
                new com.github.claudecodegui.provider.common.MessageCallback() {
                    @Override
                    public void onMessage(String type, String content) {
                        types.add(type);
                        payloads.add(content);
                    }

                    @Override
                    public void onError(String error) {
                        types.add("error:" + error);
                    }

                    @Override
                    public void onComplete(com.github.claudecodegui.provider.common.SDKResult result) {
                        // not expected for a session-id line
                    }
                });

        assertEquals(1, types.size());
        assertEquals("session_id", types.get(0));
        assertEquals("d5451c2b-751a-4248-9d75-47344e4bc885", payloads.get(0));
    }

    @Test
    public void stdinPayloadSendsEmptySessionIdForAFreshTab() {
        // Story 1.3 AC2: a new chat tab starts a NEW conversation. TabHandler's
        // create_new_tab builds a fresh ClaudeChatWindow whose SessionState has
        // no session id at all, so the first send must serialize it as the ""
        // sentinel — the value the Node side maps to "no --conversation flag"
        // (the CLI never continues implicitly). A leftover conversation id here
        // would silently resume another tab's conversation.
        com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                "hello", null, "/proj/base", "", "medium",
                java.util.Collections.emptyList(), "default", null, null);
        assertEquals("", payload.get("sessionId").getAsString());
    }

    @Test
    public void stdinPayloadCarriesAttachmentsForMaterialization() {
        List<com.github.claudecodegui.session.ClaudeSession.Attachment> attachments = List.of(
                new com.github.claudecodegui.session.ClaudeSession.Attachment("shot.png", "image/png", "aGVsbG8="));
        com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                "look", "", "/proj/base", "", "medium", attachments, "default", null, "");
        assertTrue(payload.has("attachments"));
        assertEquals(1, payload.getAsJsonArray("attachments").size());
        assertEquals("shot.png", payload.getAsJsonArray("attachments").get(0)
                .getAsJsonObject().get("fileName").getAsString());
    }

    @Test
    public void stdinPayloadForwardsNonDefaultGeminiPermissionModesUnchanged() {
        // The gemini postures plan and sandbox are legal for the CLI; the
        // stdin hop is provider-neutral and must forward whichever mode
        // SessionSendService resolved — never downgrade it here.
        for (String mode : new String[]{"plan", "sandbox", "acceptEdits", "bypassPermissions"}) {
            com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                    "hello", "", "/proj/base", "", "medium",
                    java.util.Collections.emptyList(), mode, null, null);
            assertEquals(mode, payload.get("permissionMode").getAsString());
        }
    }

    @Test
    public void configureExtraEnvCarriesIdleReapMinutesOnEverySend() {
        // Story 1.10: the silence-window watchdog in the ai-bridge reads its
        // window from GEMINI_IDLE_REAP_MINUTES. The bridge must inject it on
        // EVERY send (the bridge process is spawned per send) — with the
        // documented default 30 when the user never touched the setting, so
        // the default does not silently depend on the Node side.
        GeminiCliBridge bridge = new GeminiCliBridge();
        java.util.Map<String, String> env = new java.util.HashMap<>();
        bridge.configureExtraEnv(env);
        assertTrue(
                "GEMINI_IDLE_REAP_MINUTES must be forwarded on every send (story 1.10 Task 2)",
                env.containsKey("GEMINI_IDLE_REAP_MINUTES"));
        assertEquals("30", env.get("GEMINI_IDLE_REAP_MINUTES"));
    }

    @Test
    public void configureExtraEnvForwardsDisabledZeroFromTheSettingsBlock() throws Exception {
        // The disable affordance (gemini.idleReapMinutes = 0) must survive the
        // carriage verbatim: "0" on the env, never swallowed into a default.
        String originalHomeDir = null;
        java.lang.reflect.Field homeField = Class.forName("com.github.claudecodegui.util.PlatformUtils")
                .getDeclaredField("cachedRealHomeDir");
        homeField.setAccessible(true);
        java.nio.file.Path tempHome = java.nio.file.Files.createTempDirectory("gemini-reap-zero-home");
        try {
            originalHomeDir = (String) homeField.get(null);
            homeField.set(null, tempHome.toString());
            java.nio.file.Path codemoss = tempHome.resolve(".codemoss");
            java.nio.file.Files.createDirectories(codemoss);
            java.nio.file.Files.writeString(
                    codemoss.resolve("config.json"),
                    "{\"gemini\":{\"idleReapMinutes\":0}}");

            GeminiCliBridge bridge = new GeminiCliBridge();
            java.util.Map<String, String> env = new java.util.HashMap<>();
            bridge.configureExtraEnv(env);
            assertEquals("0", env.get("GEMINI_IDLE_REAP_MINUTES"));
        } finally {
            if (originalHomeDir != null) {
                homeField.set(null, originalHomeDir);
            }
        }
    }
}
