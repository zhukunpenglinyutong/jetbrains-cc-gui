package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies legacy raw/export projections never expose secret or unclassified answers. */
public class CodexHistoryPrivacyTest {
    /** Preserves uncertainty across recovered or corrupt indexes before reading opaque historical outputs. */
    @Test
    public void corruptOrRecoveredIndexNeverReleasesOpaqueAnswers() throws Exception {
        var directory = this.folder.newFolder("corrupt-recovered").toPath();
        for (String content : new String[]{"{not-json", "{\"version\":2,\"entries\":[]}",
                "{\"version\":1,\"conservativeMasking\":true,\"entries\":[{\"threadId\":\"thread\",\"callId\":\"ordinary\",\"questionIds\":[\"q\"],\"secretQuestionIds\":[]}]}",
                "{\"version\":1,\"entries\":[null,{\"threadId\":\"thread\",\"callId\":\"ordinary\",\"questionIds\":[\"q\"],\"secretQuestionIds\":[]}]}"}) {
            Files.writeString(directory.resolve("index.json"), content);
            var privacy = new CodexHistoryPrivacy(directory, "thread");
            var opaque = JsonParser.parseString("{\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"lost\",\"output\":\"synthetic-secret\"}}")
                    .getAsJsonObject();
            assertFalse(privacy.protect(opaque).toString().contains("synthetic-secret"));
            var ordinary = JsonParser.parseString("{\"call_id\":\"ordinary\",\"answers\":{\"q\":\"synthetic-answer\"}}")
                    .getAsJsonObject();
            assertFalse(privacy.protect(ordinary).toString().contains("synthetic-answer"));
            assertTrue(privacy.protect(opaque).toString().contains("lost"));
        }
    }
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    /** Masks result data even when its field names resemble protocol identities. */
    @Test
    public void secretResultKeysDoNotBypassMasking() throws Exception {
        var directory = this.folder.newFolder("result-keys").toPath();
        Files.writeString(directory.resolve("index.json"), """
                {"version":1,"entries":[{"threadId":"thread","callId":"call",
                "questionIds":["q"],"secretQuestionIds":["q"]},{"threadId":"thread","callId":"ordinary",
                "questionIds":["q"],"secretQuestionIds":[]}]}
                """);
        JsonObject raw = JsonParser.parseString("""
                {"payload":{"id":"call","call_id":"call","type":"function_call_output","status":"completed",
                "output":{"id":"synthetic-secret","name":"synthetic-secret","path":"synthetic-secret",
                "callId":"synthetic-secret","status":"synthetic-secret","type":"synthetic-secret"}}}
                """).getAsJsonObject();
        JsonObject safe = new CodexHistoryPrivacy(directory, "thread").protect(raw).getAsJsonObject("payload");
        assertEquals("call", safe.get("id").getAsString());
        assertEquals("function_call_output", safe.get("type").getAsString());
        assertEquals("completed", safe.get("status").getAsString());
        assertFalse(safe.get("output").toString().contains("synthetic-secret"));
        raw.getAsJsonObject("payload").add("output", JsonParser.parseString("""
                {"callId":"ordinary","itemId":"ordinary","answers":{"q":"synthetic-secret"}}
                """));
        assertFalse(new CodexHistoryPrivacy(directory, "thread").protect(raw).toString().contains("synthetic-secret"));
    }

    /** Keeps normal history readable when classification metadata is unavailable. */
    @Test
    public void corruptIndexDoesNotEraseNormalMessagesOrHistoryMetadata() throws Exception {
        var directory = this.folder.newFolder("normal-history").toPath();
        Files.writeString(directory.resolve("index.json"), "{broken");
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(directory, "thread");
        JsonObject normal = JsonParser.parseString("""
                {"timestamp":"2026-10-02T00:00:00Z","payload":{"type":"message","role":"assistant",
                "content":[{"type":"text","text":"Normal reply"},{"type":"thinking","thinking":"Normal reasoning"}]},
                "createdAt":10,"updatedAt":20}
                """).getAsJsonObject();
        JsonObject protectedNormal = privacy.protect(normal);
        assertEquals(normal, protectedNormal);
        normal.getAsJsonObject("payload").getAsJsonArray("content").get(0).getAsJsonObject()
                .addProperty("text", "{\"answers\":{\"q\":\"Normal model JSON\"}}");
        assertEquals(normal, privacy.protect(normal));
        JsonObject tool = JsonParser.parseString("""
                {"payload":{"type":"commandExecution","id":"cmd","command":"git status","exitCode":0,
                "durationMs":5,"aggregatedOutput":"synthetic-secret"}}
                """).getAsJsonObject();
        JsonObject protectedTool = privacy.protect(tool).getAsJsonObject("payload");
        assertEquals("git status", protectedTool.get("command").getAsString());
        assertEquals(0, protectedTool.get("exitCode").getAsInt());
        assertEquals(5, protectedTool.get("durationMs").getAsInt());
        assertFalse(protectedTool.toString().contains("synthetic-secret"));
    }

    /** Reads atomic journal fragments from the selected native home only. */
    @Test
    public void journalFragmentsKeepHomeBoundariesAndNullableMcpCorrelation() throws Exception {
        var directory = this.folder.newFolder("journal").toPath();
        String fingerprint = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest("current-home".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        Files.writeString(directory.resolve(fingerprint + ".record.first.json"), """
                {"version":1,"entries":[{"threadId":"thread","callId":"ordinary",
                "questionIds":["q"],"secretQuestionIds":[]}]}
                """);
        Files.writeString(directory.resolve(fingerprint + ".record.second.json"), """
                {"version":1,"entries":[{"threadId":"thread","method":"mcpServer/elicitation/request",
                "turnId":null,"callId":null,"itemId":null,"secretQuestionIds":["q"]}]}
                """);
        Files.writeString(directory.resolve("other-home.json"), "{corrupt");
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(directory, "thread", "current-home");
        assertTrue(privacy.protect(JsonParser.parseString("{\"call_id\":\"ordinary\",\"answers\":{\"q\":\"public-answer\"}}")
                .getAsJsonObject()).toString().contains("public-answer"));
        JsonObject opaque = JsonParser.parseString("""
                {"payload":{"type":"function_call_output","call_id":"actual-tool-call","output":"synthetic-secret"}}
                """).getAsJsonObject();
        assertFalse(privacy.protect(opaque).toString().contains("synthetic-secret"));
        assertTrue(new CodexHistoryPrivacy(directory, "other-thread", "current-home")
                .protect(opaque).toString().contains("synthetic-secret"));
        assertTrue(privacy.protect(JsonParser.parseString("{\"type\":\"reasoning\",\"content\":[\"plain reasoning\"]}")
                .getAsJsonObject()).toString().contains("plain reasoning"));
    }

    /** Preserves explanatory prose while hiding truncated and nested JSON answers. */
    @Test
    public void reasoningProseAndJsonAnswerFragmentsHaveDifferentPrivacyBoundaries() throws Exception {
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(this.folder.newFolder("prose").toPath(), "thread");
        String prose = "Explain the \"answers\": field before writing the request.";
        JsonObject reasoning = new JsonObject();
        reasoning.addProperty("type", "reasoning");
        reasoning.addProperty("content", prose);
        assertTrue(privacy.protect(reasoning).toString().contains("Explain the"));
        for (String answer : new String[]{"{\"answers\":{\"q\":\"synthetic-secret", "[{\"answers\":{\"q\":\"synthetic-secret\"}}]"}) {
            JsonObject output = new JsonObject();
            output.addProperty("output", answer);
            assertFalse(privacy.protect(output).toString().contains("synthetic-secret"));
        }
    }

    /** Keeps outputs hidden when the index container exists but is not readable as a directory. */
    @Test
    public void invalidIndexContainerKeepsOpaqueOutputsHidden() throws Exception {
        var directory = this.folder.newFile("invalid-container").toPath();
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(directory, "thread");
        JsonObject output = new JsonObject();
        output.addProperty("id", "call");
        output.addProperty("output", "synthetic-secret");
        assertFalse(privacy.protect(output).toString().contains("synthetic-secret"));
        assertEquals("call", privacy.protect(output).get("id").getAsString());
    }

    @Test
    public void coldHistoryPreservesClassifiedNormalAnswers() throws Exception {
        var directory = this.folder.newFolder("index").toPath();
        Files.writeString(directory.resolve("index.json"), """
                {"version":1,"entries":[{"threadId":"thread","callId":"call",
                "questionIds":["normal","secret"],"secretQuestionIds":["secret"]}]}
                """);
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(directory, "thread");
        JsonObject raw = JsonParser.parseString("""
                {"payload":{"type":"function_call_output","call_id":"call",
                "output":"{\\"answers\\":{\\"normal\\":\\"ordinary\\",\\"secret\\":\\"synthetic-secret\\"}}"}}
                """).getAsJsonObject();
        String projected = privacy.protect(raw).toString();
        assertTrue(projected.contains("ordinary"));
        assertFalse(projected.contains("synthetic-secret"));
        assertTrue(raw.toString().contains("synthetic-secret"));
    }

    @Test
    public void missingIndexMasksRecognizableAnswerMapsButKeepsModelText() throws Exception {
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(this.folder.newFolder("missing").toPath(), "thread");
        JsonObject raw = JsonParser.parseString("""
                {"payload":{"output":{"answers":{"unknown":"synthetic-secret"}}},"text":"model prose"}
                """).getAsJsonObject();
        String projected = privacy.protect(raw).toString();
        assertFalse(projected.contains("synthetic-secret"));
        assertTrue(projected.contains("model prose"));
    }

    @Test
    public void matchingQuestionNameCannotReleaseAnUnknownCallOrTurn() throws Exception {
        var directory = this.folder.newFolder("scoped").toPath();
        Files.writeString(directory.resolve("index.json"), """
                {"version":1,"entries":[{"threadId":"thread","turnId":"turn","callId":"known",
                "questionIds":["q"],"secretQuestionIds":[]}]}
                """);
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(directory, "thread");
        JsonObject known = JsonParser.parseString("""
                {"raw":{"codexThreadId":"thread","codexTurnId":"turn","codexItemId":"known:result",
                  "message":{"content":[{"type":"tool_result","tool_use_id":"known","content":{"answers":{"q":"public-answer"}}}]}}}
                """).getAsJsonObject();
        assertTrue(privacy.protect(known).toString().contains("public-answer"));
        known.getAsJsonObject("raw").addProperty("codexTurnId", "other-turn");
        assertFalse(privacy.protect(known).toString().contains("public-answer"));
        JsonObject unknown = JsonParser.parseString("""
                {"payload":{"type":"function_call_output","call_id":"other-call","output":{"answers":{"q":"synthetic-secret"}}}}
                """).getAsJsonObject();
        assertFalse(privacy.protect(unknown).toString().contains("synthetic-secret"));
        JsonObject malformed = JsonParser.parseString("""
                {"payload":{"output":"{\\"answers\\":{\\"q\\":\\"synthetic-secret\\"}"}}
                """).getAsJsonObject();
        assertFalse(privacy.protect(malformed).toString().contains("synthetic-secret"));
    }

    @Test
    public void nativeHomeFingerprintAndIndexVersionBoundOrdinaryClassification() throws Exception {
        var directory = this.folder.newFolder("homes").toPath();
        String fingerprint = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest("other-home".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        Files.writeString(directory.resolve(fingerprint + ".json"), """
                {"version":1,"entries":[{"threadId":"thread","callId":"known","questionIds":["q"],"secretQuestionIds":[]}]}
                """);
        JsonObject answer = JsonParser.parseString("{\"call_id\":\"known\",\"answers\":{\"q\":\"synthetic-secret\"}}").getAsJsonObject();
        assertFalse(new CodexHistoryPrivacy(directory, "thread", "current-home").protect(answer).toString().contains("synthetic-secret"));
        assertTrue(new CodexHistoryPrivacy(directory, "thread", "other-home").protect(answer).toString().contains("synthetic-secret"));
    }

    @Test
    public void invalidAnswerContainersStayMaskedAndNormalTypedAnswersRemainVisible() throws Exception {
        var directory = this.folder.newFolder("typed").toPath();
        Files.writeString(directory.resolve("index.json"), """
                {"version":1,"entries":[{"threadId":"thread","turnId":"turn","callId":"ordinary",
                "questionIds":["q"],"secretQuestionIds":[]},{"threadId":"thread","turnId":"turn",
                "questionIds":["q"],"secretQuestionIds":["q"]}]}
                """);
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(directory, "thread");
        JsonObject normal = JsonParser.parseString("""
                {"codexTurnId":"turn","call_id":"ordinary","answers":{"q":{"answers":["ordinary-answer"]}}}
                """).getAsJsonObject();
        assertTrue(privacy.protect(normal).toString().contains("ordinary-answer"));
        JsonObject reasoning = JsonParser.parseString("""
                {"codexTurnId":"turn","type":"reasoning","id":"reason","content":["plain reasoning"]}
                """).getAsJsonObject();
        assertTrue(privacy.protect(reasoning).toString().contains("plain reasoning"));
        for (String answers : new String[]{"\"synthetic-secret\"", "[\"synthetic-secret\"]"}) {
            JsonObject malformed = JsonParser.parseString("{\"answers\":" + answers + "}").getAsJsonObject();
            assertFalse(privacy.protect(malformed).toString().contains("synthetic-secret"));
        }
        Files.writeString(directory.resolve("index.json"), """
                {"version":1.5,"entries":[{"threadId":"thread","turnId":"turn","callId":"ordinary",
                "questionIds":["q"],"secretQuestionIds":[]}]}
                """);
        assertFalse(new CodexHistoryPrivacy(directory, "thread").protect(normal).toString().contains("ordinary-answer"));
    }
}
