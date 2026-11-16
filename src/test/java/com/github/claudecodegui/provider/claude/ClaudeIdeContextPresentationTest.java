package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.SessionLiteReader;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.MessageParser;
import com.github.claudecodegui.util.MessageJsonConverter;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PluginIdeContext;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Exercises the same persisted native record through titles, replay, live transport, and export. */
public class ClaudeIdeContextPresentationTest {
    private static final String LEGACY_PREFIX = "<system-reminder>\nThe following IDE context applies only to this user message.\n";

    /** Provides isolated native transcript files for presentation checks. */
    @Rule public TemporaryFolder temporaryFolder = new TemporaryFolder();

    /** Keeps current leading context out of live and restored presentation. */
    @Test
    public void nativeRecordHidesOnlyPluginContextAcrossAllPresentationPaths() throws Exception {
        this.assertContextHidden(false);
    }

    /** Keeps transcripts written before the command fix readable. */
    @Test
    public void legacyTrailingContextStaysHiddenAcrossAllPresentationPaths() throws Exception {
        this.assertContextHidden(true);
    }

    private void assertContextHidden(boolean legacy) throws Exception {
        String prompt = "Explain <skill>keep this</skill>";
        JsonObject raw = legacy
                ? userMessage(prompt, LEGACY_PREFIX + "private/path and selected code\n</system-reminder>")
                : userMessage(PluginIdeContext.PREFIX + "private/path and selected code\n</system-reminder>", prompt);
        String original = raw.toString();

        assertEquals(prompt, new SessionLiteReader().extractFirstPromptFromHead(original + "\n"));
        assertEquals(prompt, new ClaudeHistoryParser().generateSummary(List.of(
                new Gson().fromJson(raw, ClaudeHistoryReader.ConversationMessage.class))));

        JsonObject replay = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(raw);
        assertVisiblePrompt(replay, prompt);
        ClaudeSession.Message parsed = new MessageParser().parseServerMessage(raw);
        JsonObject transport = JsonParser.parseString(MessageJsonConverter.convertMessagesToJson(List.of(parsed)))
                .getAsJsonArray().get(0).getAsJsonObject();
        assertEquals(prompt, transport.get("content").getAsString());
        assertVisiblePrompt(transport.getAsJsonObject("raw"), prompt);

        Path projects = this.temporaryFolder.newFolder("projects").toPath();
        String cwd = this.temporaryFolder.newFolder("workspace").getAbsolutePath();
        Path project = projects.resolve(PathUtils.getSanitizedPathCandidates(cwd).get(0));
        Files.createDirectories(project);
        Path transcript = project.resolve("fixture-session.jsonl");
        Files.writeString(transcript, original + "\n");
        String exported = new ClaudeHistorySearchService(projects, null, null)
                .getSessionMessagesAsJson(cwd, "fixture-session");
        assertVisiblePrompt(JsonParser.parseString(exported).getAsJsonArray().get(0).getAsJsonObject(), prompt);
        assertFalse(exported.contains("private/path"));
        assertEquals("Native transcript must remain unchanged", original + "\n", Files.readString(transcript));
        assertEquals(original, raw.toString());

        String context = (legacy ? LEGACY_PREFIX : PluginIdeContext.PREFIX) + "private/path and selected code\n</system-reminder>";
        String flattened = legacy ? prompt + "\n" + context : context + "\n" + prompt;
        ClaudeSession.Message live = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, flattened, raw);
        JsonObject liveTransport = JsonParser.parseString(MessageJsonConverter.convertMessagesToJson(List.of(live)))
                .getAsJsonArray().get(0).getAsJsonObject();
        assertEquals(prompt, liveTransport.get("content").getAsString());
        assertVisiblePrompt(liveTransport.getAsJsonObject("raw"), prompt);
    }

    /** Preserves user-authored tags even when their text resembles the plugin's wrapper. */
    @Test
    public void genericTagsAndQuotedPluginMarkersRemainUserContent() {
        for (String prefix : List.of(PluginIdeContext.PREFIX, LEGACY_PREFIX)) {
            for (String literal : List.of("<system-reminder>keep this</system-reminder>",
                    "<skill>keep this</skill>", prefix + "quoted example\n</system-reminder>")) {
                JsonObject single = userMessage(literal);
                assertVisiblePrompt(ClaudeSessionQueryService.normalizeClaudeHistoryMessage(single), literal);
                ClaudeSession.Message optimistic = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, literal, null);
                JsonObject visible = JsonParser.parseString(MessageJsonConverter.convertMessagesToJson(List.of(optimistic)))
                        .getAsJsonArray().get(0).getAsJsonObject();
                assertEquals(literal, visible.get("content").getAsString());

                String context = prefix + "actual IDE context\n</system-reminder>";
                JsonObject withContext = prefix.equals(LEGACY_PREFIX) ? userMessage(literal, context) : userMessage(context, literal);
                assertVisiblePrompt(ClaudeSessionQueryService.normalizeClaudeHistoryMessage(withContext), literal);
            }
        }
        JsonObject genericTrailingTag = userMessage("Explain this", "<skill>literal second block</skill>");
        JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(genericTrailingTag);
        assertEquals(2, normalized.getAsJsonObject("message").getAsJsonArray("content").size());

        JsonObject interiorMarker = userMessage("Quoted example:", PluginIdeContext.PREFIX + "literal\n</system-reminder>", "Keep this too");
        assertEquals(interiorMarker, ClaudeSessionQueryService.normalizeClaudeHistoryMessage(interiorMarker));
    }

    /** Checks user command tags after discarding editor code that may quote the same tags. */
    @Test
    public void commandFilteringIgnoresTagsInsideEditorContext() {
        String prompt = "Explain this parser";
        JsonObject codeSelection = userMessage(PluginIdeContext.PREFIX
                + "const commandTag = '<command-name>/compact</command-name>';\n</system-reminder>", prompt);
        ClaudeSession.Message parsed = new MessageParser().parseServerMessage(codeSelection);
        assertNotNull("Selected code must not hide an ordinary user message", parsed);
        assertEquals(prompt, parsed.content);

        JsonObject bookkeeping = userMessage(PluginIdeContext.PREFIX + "Active file: commands.ts\n</system-reminder>",
                "[Attachment: notes.txt]", "<command-name>/compact</command-name>\n<command-args></command-args>");
        assertNull("A final block with only bookkeeping tags must stay hidden", new MessageParser().parseServerMessage(bookkeeping));

        // Recorded by Claude Code 2.1.311 for "/compact keep decisions"; <command-message> keeps it visible.
        String record = "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n"
                + "            <command-args>keep decisions</command-args>";
        ClaudeSession.Message shown = new MessageParser().parseServerMessage(
                userMessage(PluginIdeContext.PREFIX + "Active file: commands.ts\n</system-reminder>", record));
        assertNotNull("The native command record shows as the command", shown);
        assertEquals(record, shown.content);
        assertVisiblePrompt(shown.raw, record);
    }

    /** Fails when the bridge and this filter stop agreeing on the wrapper, which would leak context into bubbles. */
    @Test
    public void bridgeWritesTheMarkerThatJavaHides() throws Exception {
        String bridge = Files.readString(Path.of("ai-bridge", "services", "claude", "persistent-query-service.js"));
        assertTrue(bridge.contains("text: `" + PluginIdeContext.PREFIX.replace("\n", "\\n")));
    }

    /** Prevents later history and transport passes from treating a user's quoted wrapper as injected context. */
    @Test
    public void repeatedPresentationKeepsAttachedUserTextThatQuotesLegacyContext() {
        String literal = LEGACY_PREFIX + "quoted example from an old transcript\n</system-reminder>";
        JsonObject raw = userMessage(PluginIdeContext.PREFIX + "Active file: current.ts\n</system-reminder>",
                "[Attachment: notes.txt]", literal);
        JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(raw);
        assertEquals(2, normalized.getAsJsonObject("message").getAsJsonArray("content").size());
        assertEquals(normalized, ClaudeSessionQueryService.normalizeClaudeHistoryMessage(normalized));

        ClaudeSession.Message parsed = new MessageParser().parseServerMessage(normalized);
        assertNotNull(parsed);
        assertEquals("[Attachment: notes.txt]\n" + literal, parsed.content);
        JsonObject transport = JsonParser.parseString(MessageJsonConverter.convertMessagesToJson(List.of(parsed)))
                .getAsJsonArray().get(0).getAsJsonObject();
        assertEquals(parsed.content, transport.get("content").getAsString());
        assertEquals(normalized.getAsJsonObject("message").get("content"),
                transport.getAsJsonObject("raw").getAsJsonObject("message").get("content"));
        ClaudeSession.Message restored = new MessageParser().parseServerMessage(transport);
        assertNotNull(restored);
        assertEquals(parsed.content, restored.content);
        assertEquals(transport.getAsJsonObject("raw"), PluginIdeContext.visibleMessage(transport.getAsJsonObject("raw")));
    }

    /** Keeps a quoted copy of the actual context after the parser has already removed the injected block. */
    @Test
    public void liveTransportDoesNotStripTheUserTextTwice() {
        String literal = PluginIdeContext.PREFIX + "Active file: current.ts\n</system-reminder>";
        JsonObject raw = userMessage(literal, literal);
        ClaudeSession.Message parsed = new MessageParser().parseServerMessage(raw);
        assertNotNull(parsed);
        assertEquals(literal, parsed.content);
        JsonObject transport = JsonParser.parseString(MessageJsonConverter.convertMessagesToJson(List.of(parsed)))
                .getAsJsonArray().get(0).getAsJsonObject();
        assertEquals(literal, transport.get("content").getAsString());
        assertVisiblePrompt(transport.getAsJsonObject("raw"), literal);
    }

    private static JsonObject userMessage(String... texts) {
        JsonArray content = new JsonArray();
        for (String text : texts) {
            JsonObject block = new JsonObject();
            block.addProperty("type", "text");
            block.addProperty("text", text);
            content.add(block);
        }
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.addProperty("uuid", "original-user-id");
        raw.add("message", message);
        return raw;
    }

    private static void assertVisiblePrompt(JsonObject raw, String prompt) {
        JsonArray blocks = raw.getAsJsonObject("message").getAsJsonArray("content");
        assertEquals(1, blocks.size());
        assertEquals(prompt, blocks.get(0).getAsJsonObject().get("text").getAsString());
    }
}
