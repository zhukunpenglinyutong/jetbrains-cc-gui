package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Java-side parse of the shared sanitized trace fixture (task 1.6 of the
 * {@code migrate-codex-to-app-server} change).
 *
 * <p>The same NDJSON fixture is parsed by the Node layer
 * ({@code ai-bridge/services/codex/testing/trace/codex-trace-fixture.test.js})
 * and the webview layer ({@code webview/src/utils/codexTraceFixture.test.ts}).
 * Keeping one file proves all three layers agree on the versioned trace
 * contract: delayed ids, child requests, clientMessageIds, show/close
 * delivery sequences, secret marks, workspace diff snapshots, and checkable
 * terminal counts. The fixture carries identities and flags only — never
 * secret answer text or credentials.
 */
public class CodexTraceFixtureTest {

    private static final String FIXTURE_RELATIVE_PATH =
            "ai-bridge/services/codex/testing/trace/fixtures/appserver-trace-v1.ndjson";

    @Test
    public void sharedTraceFixtureParsesAtTheJavaLayer() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        assertEquals(1, events.get(0).get("traceVersion").getAsInt());
        assertTrue("fixture records a meaningful event stream", events.size() > 10);
    }

    @Test
    public void delayedIdPlacesNotifyBeforeAck() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        int notifyIndex = indexOfFirst(events, event ->
                "notify".equals(kind(event)) && "item/started".equals(method(event)));
        int ackIndex = indexOfFirst(events, event ->
                "response".equals(kind(event)) && event.has("ackForClientRequestId"));
        assertTrue(notifyIndex >= 0);
        assertTrue(ackIndex >= 0);
        assertTrue("notify must precede the delayed ack", notifyIndex < ackIndex);
    }

    @Test
    public void childRequestCarriesParentThreadIdentity() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        List<JsonObject> childRequests = filter(events, event ->
                "server_request".equals(kind(event)) && event.has("parentThreadId")
                        && !event.get("parentThreadId").isJsonNull());
        assertEquals(1, childRequests.size());
        assertEquals("th-child-0002", childRequests.get(0).get("threadId").getAsString());
        assertEquals("th-root-0001", childRequests.get(0).get("parentThreadId").getAsString());
        // The child request exercises a string server id as well.
        assertEquals("server-str-0009", childRequests.get(0).get("id").getAsString());
    }

    @Test
    public void userMessageEventsKeepDistinctClientMessageIds() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        List<JsonObject> userMessages = filter(events, event ->
                "notify".equals(kind(event))
                        && "userMessage".equals(text(event, "itemType")));
        assertTrue("fixture records two user messages", userMessages.size() >= 2);
        Map<String, JsonObject> byClientMessageId = new HashMap<>();
        for (JsonObject event : userMessages) {
            String clientMessageId = text(event, "clientMessageId");
            assertNotNull(clientMessageId);
            assertFalse("clientMessageIds never collide",
                    byClientMessageId.containsKey(clientMessageId));
            byClientMessageId.put(clientMessageId, event);
        }
    }

    @Test
    public void showCloseDeliveriesAreMonotonicAndTombstoned() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        List<JsonObject> deliveries = filter(events, event ->
                "interaction_show".equals(kind(event))
                        || "interaction_close".equals(kind(event)));
        assertTrue(deliveries.size() >= 3);

        int previousSequence = -1;
        JsonObject lateShow = null;
        for (JsonObject event : deliveries) {
            int sequence = event.get("deliverySequence").getAsInt();
            assertTrue("deliverySequence is strictly increasing", sequence > previousSequence);
            previousSequence = sequence;
            if ("interaction_show".equals(kind(event)) && sequence == 3) {
                lateShow = event;
            }
        }
        assertNotNull("late show replay is recorded", lateShow);
        assertEquals(true, lateShow.get("resolvedTombstone").getAsBoolean());
    }

    @Test
    public void secretMarksSeparateSecretFromNormalQuestion() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        Map<String, Boolean> marks = new HashMap<>();
        for (JsonObject event : events) {
            if ("secret_marked".equals(kind(event))) {
                marks.put(event.get("questionId").getAsString(),
                        event.get("isSecret").getAsBoolean());
            }
        }
        assertEquals(Boolean.FALSE, marks.get("q-0001"));
        assertEquals(Boolean.TRUE, marks.get("q-0002"));
    }

    @Test
    public void terminalCountIsCheckableAcrossThreads() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        List<JsonObject> terminals = filter(events, event ->
                "notify".equals(kind(event)) && "turn/completed".equals(method(event)));
        assertEquals(2, terminals.size());
        assertEquals(1, filter(terminals, event ->
                "th-root-0001".equals(text(event, "threadId"))).size());
        assertEquals(1, filter(terminals, event ->
                "th-child-0002".equals(text(event, "threadId"))).size());
    }

    @Test
    public void workspaceDiffSnapshotCarriesCountsNotContent() throws IOException {
        List<JsonObject> events = loadFixtureEvents();
        List<JsonObject> diffEvents = filter(events, event ->
                "workspace_diff".equals(kind(event)));
        assertEquals(1, diffEvents.size());
        JsonObject diff = diffEvents.get(0);
        assertEquals(1, diff.get("stagedCount").getAsInt());
        assertEquals(2, diff.get("unstagedCount").getAsInt());
        assertEquals(1, diff.get("untrackedCount").getAsInt());
        assertFalse("diff content is never embedded", diff.has("patch"));
    }

    @Test
    public void fixtureContainsNoSecretMaterial() throws IOException {
        String raw = Files.readString(resolveFixture(), StandardCharsets.UTF_8);
        for (String forbidden : new String[]{"sk-", "api_key", "apiKey", "Bearer ", "password"}) {
            assertFalse("fixture must not contain " + forbidden, raw.contains(forbidden));
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static Path resolveFixture() {
        Path dir = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        for (int i = 0; i < 6 && dir != null; i++) {
            Path candidate = dir.resolve(FIXTURE_RELATIVE_PATH);
            if (Files.exists(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new AssertionError("shared trace fixture not found: " + FIXTURE_RELATIVE_PATH);
    }

    private static List<JsonObject> loadFixtureEvents() throws IOException {
        List<String> lines = Files.readAllLines(resolveFixture(), StandardCharsets.UTF_8);
        List<JsonObject> events = new ArrayList<>();
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            events.add(JsonParser.parseString(trimmed).getAsJsonObject());
        }
        assertFalse("fixture is empty", events.isEmpty());
        return events;
    }

    private static String kind(JsonObject event) {
        return text(event, "kind");
    }

    private static String method(JsonObject event) {
        return text(event, "method");
    }

    private static String text(JsonObject obj, String field) {
        return obj.has(field) && obj.get(field).isJsonPrimitive()
                ? obj.get(field).getAsString() : null;
    }

    private static List<JsonObject> filter(
            List<JsonObject> events,
            java.util.function.Predicate<JsonObject> matcher
    ) {
        List<JsonObject> matched = new ArrayList<>();
        for (JsonObject event : events) {
            if (matcher.test(event)) {
                matched.add(event);
            }
        }
        return matched;
    }

    private static int indexOfFirst(
            List<JsonObject> events,
            java.util.function.Predicate<JsonObject> matcher
    ) {
        for (int i = 0; i < events.size(); i++) {
            if (matcher.test(events.get(i))) {
                return i;
            }
        }
        return -1;
    }
}
