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

/** Exercises the same persisted native record through titles, replay, live transport, and export. */
public class ClaudeIdeContextPresentationTest {
    @Rule public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void nativeRecordHidesOnlyPluginContextAcrossAllPresentationPaths() throws Exception {
        String prompt = "Explain <skill>keep this</skill>";
        JsonObject raw = userMessage(prompt, PluginIdeContext.PREFIX + "private/path and selected code\n</system-reminder>");
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

        Path projects = temporaryFolder.newFolder("projects").toPath();
        String cwd = temporaryFolder.newFolder("workspace").getAbsolutePath();
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
    }

    @Test
    public void genericTagsAndQuotedPluginMarkersRemainUserContent() {
        for (String literal : List.of("<system-reminder>keep this</system-reminder>",
                "<skill>keep this</skill>", PluginIdeContext.PREFIX + "quoted example\n</system-reminder>")) {
            JsonObject single = userMessage(literal);
            assertVisiblePrompt(ClaudeSessionQueryService.normalizeClaudeHistoryMessage(single), literal);
            ClaudeSession.Message optimistic = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, literal, null);
            JsonObject visible = JsonParser.parseString(MessageJsonConverter.convertMessagesToJson(List.of(optimistic)))
                    .getAsJsonArray().get(0).getAsJsonObject();
            assertEquals(literal, visible.get("content").getAsString());

            JsonObject withContext = userMessage(literal, PluginIdeContext.PREFIX + "actual IDE context\n</system-reminder>");
            assertVisiblePrompt(ClaudeSessionQueryService.normalizeClaudeHistoryMessage(withContext), literal);
        }
        JsonObject genericTrailingTag = userMessage("Explain this", "<skill>literal second block</skill>");
        JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(genericTrailingTag);
        assertEquals(2, normalized.getAsJsonObject("message").getAsJsonArray("content").size());
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
