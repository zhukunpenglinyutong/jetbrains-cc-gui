package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.lang.reflect.Proxy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for provider-aware history loading, pagination, and frontend conversion.
 */
public class HistoryMessageInjectorTest {
    /** The browser fixture must match the actual full and paged legacy projection. */
    @Test
    public void keepsReloadedBatchFixtureAlignedWithTheHistoryReader() throws Exception {
        for (String name : List.of("codex-reloaded-tool-batch", "codex-interrupted-command-history")) {
            JsonObject fixture = com.google.gson.JsonParser.parseString(Files.readString(
                    Path.of("webview/e2e/fixtures/" + name + ".json"))).getAsJsonObject();
            JsonArray records = fixture.getAsJsonArray("records");
            List<JsonObject> complete = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            assertEquals(name, fixture.get("messages"), new com.google.gson.Gson().toJsonTree(complete));
            var page = HistoryMessageInjector.paginateCodexMessages(records, null, 30);
            assertEquals(1, page.totalTurns);
            assertEquals(complete, page.messages);
        }
    }

    /** Reloaded commentary and hidden reasoning share the tools' recorded turn identity. */
    @Test
    public void preservesRecordedScopeAroundNativeToolBatches() {
        JsonArray records = new JsonArray();
        records.add(com.google.gson.JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
        JsonObject commentary = responseItemAssistantMessage("2026-10-09T03:31:00Z", "Checking the local changes");
        commentary.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough",
                com.google.gson.JsonParser.parseString("{\"turn_id\":\"own\"}"));
        records.add(commentary);
        records.add(com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"own",
                "item":{"type":"CommandExecution","id":"first","status":"completed","command":"git diff","exit_code":0}}}
                """));
        records.add(com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"reasoning","id":"hidden-reasoning","summary":[],
                "internal_chat_message_metadata_passthrough":{"turn_id":"own"}}}
                """));
        records.add(com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"own",
                "item":{"type":"CommandExecution","id":"second","status":"completed","command":"git status","exit_code":0}}}
                """));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(6, messages.size());
        for (JsonObject message : messages) {
            JsonObject raw = message.getAsJsonObject("raw");
            assertEquals("root", HistoryMessageInjector.getStringProperty(raw, "codexThreadId"));
            assertEquals("own", HistoryMessageInjector.getStringProperty(raw, "codexTurnId"));
        }
        assertEquals("hidden-reasoning", messages.get(3).getAsJsonObject("raw").get("uuid").getAsString().substring("codex-legacy:".length()));
        assertEquals("", getOnlyRawContentBlock(messages.get(3)).get("thinking").getAsString());
    }

    /** Native activity keeps path-only launch receipts tied to the real child thread. */
    @Test
    public void restoresNativeSubagentActivityWithoutOverwritingTheLaunch() {
        JsonArray records = new JsonArray();
        records.add(functionCall("2026-10-04T00:00:00Z", "spawn-one", "spawn_agent", "{\"task_name\":\"review_ui\"}"));
        records.add(com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"SubAgentActivity","id":"spawn-one","kind":"started",
                "agent_thread_id":"child-thread","agent_path":"/root/review_ui"}}}
                """));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(2, messages.size());
        assertEquals("spawn_agent", getOnlyRawContentBlock(messages.get(0)).get("name").getAsString());
        JsonObject activity = messages.get(1).getAsJsonObject("raw");
        assertEquals("subAgentActivity", activity.get("codexItemType").getAsString());
        assertEquals("child-thread", getOnlyRawContentBlock(messages.get(1)).getAsJsonObject("input").get("agentThreadId").getAsString());
        assertEquals("/root/review_ui", getOnlyRawContentBlock(messages.get(1)).getAsJsonObject("input").get("agentPath").getAsString());
        assertFalse(messages.get(0).getAsJsonObject("raw").get("uuid").equals(activity.get("uuid")));
    }

    /** A completed image view has a paired result even when its item omits status. */
    @Test
    public void restoresCompletedImageViews() {
        JsonArray records = new JsonArray();
        JsonObject event = com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "completed_at_ms":1000,"item":{"type":"ImageView","id":"image","path":"file:///preview.png"}}}
                """).getAsJsonObject();
        records.add(event);
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(2, messages.size());
        assertEquals("imageView", getOnlyRawContentBlock(messages.get(0)).get("name").getAsString());
        assertEquals("file:///preview.png", getOnlyRawContentBlock(messages.get(0)).getAsJsonObject("input").get("path").getAsString());
        assertEquals("image", getOnlyRawContentBlock(messages.get(1)).get("tool_use_id").getAsString());
        assertFalse(getOnlyRawContentBlock(messages.get(1)).get("is_error").getAsBoolean());
    }
    /** Uses recorded file changes when a wrapper computes its patch at runtime. */
    @Test
    public void restoresRecordedFileChangeForDynamicPatch() {
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "dynamic-patch", "exec",
                "const patch = buildPatch(); text(await tools.apply_patch(patch));"));
        JsonObject event = com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "completed_at_ms":1000,"item":{"type":"FileChange","id":"native-patch","status":"completed",
                "changes":{"a.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\\n-old\\n+new\\n","move_path":"b.ts"},
                "added.ts":{"type":"add","content":"created\\n"},"gone.ts":{"type":"delete","content":"removed\\n"}},
                "stdout":"Patch applied","stderr":""}}}
                """).getAsJsonObject();
        String original = event.toString();
        records.add(event);
        records.add(event.deepCopy());
        records.add(customToolCallOutput("2026-10-02T00:00:01Z", "dynamic-patch", "Script completed"));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(2, messages.size());
        JsonObject nativeRaw = messages.get(0).getAsJsonObject("raw");
        JsonObject tool = getOnlyRawContentBlock(messages.get(0));
        assertEquals("file_change", tool.get("name").getAsString());
        assertEquals("thread", nativeRaw.get("codexThreadId").getAsString());
        assertEquals("turn", nativeRaw.get("codexTurnId").getAsString());
        JsonArray changes = tool.getAsJsonObject("input").getAsJsonArray("changes");
        assertEquals(3, changes.size());
        assertEquals("b.ts", changes.get(0).getAsJsonObject().getAsJsonObject("kind").get("movePath").getAsString());
        assertEquals("+created", changes.get(1).getAsJsonObject().get("diff").getAsString());
        assertEquals("-removed", changes.get(2).getAsJsonObject().get("diff").getAsString());
        assertEquals("completed", tool.getAsJsonObject("input").get("status").getAsString());
        assertEquals("Patch applied", getOnlyRawContentBlock(messages.get(1)).get("content").getAsString());
        assertEquals(original, event.toString());
    }

    /** Preserves native failure output without borrowing the outer script's outcome. */
    @Test
    public void restoresRecordedDynamicPatchFailure() {
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "dynamic-failed", "exec", "await tools.apply_patch(result.output);"));
        records.add(com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"FileChange","id":"native-failed","status":"failed",
                "changes":{"a.ts":{"type":"update","unified_diff":"-old\\n+new","move_path":null}},
                "stdout":"","stderr":"apply_patch verification failed"}}}
                """));
        records.add(customToolCallOutput("2026-10-02T00:00:01Z", "dynamic-failed", "Script completed"));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(2, messages.size());
        JsonObject output = getOnlyRawContentBlock(messages.get(1));
        assertTrue(output.get("is_error").getAsBoolean());
        assertEquals("apply_patch verification failed", output.get("content").getAsString());
    }

    /** Restores the literal patch-array loop used by the referenced session without guessing per-file outcomes. */
    @Test
    public void previewsPatchesFromImmutableArrayLoop() {
        String first = "*** Begin Patch\n*** Add File: a.ts\n+first\n*** End Patch";
        String second = "*** Begin Patch\n*** Add File: b.ts\n+second\n*** End Patch";
        var gson = new com.google.gson.Gson();
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "patch-array", "exec",
                "const patches = [" + gson.toJson(first) + "," + gson.toJson(second)
                        + "]; for (const p of patches) text(await tools.apply_patch(p));"));
        records.add(customToolCallOutput("2026-10-02T00:00:01Z", "patch-array", "Script completed"));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(4, messages.size());
        for (int index = 0; index < 2; index++) {
            JsonObject tool = getOnlyRawContentBlock(messages.get(index));
            assertEquals("apply_patch", tool.get("name").getAsString());
            assertEquals(index == 0 ? first : second, tool.getAsJsonObject("input").get("patch").getAsString());
            assertEquals("unknown", tool.getAsJsonObject("input").get("status").getAsString());
        }
        assertEquals("exec", getOnlyRawContentBlock(messages.get(2)).get("name").getAsString());
        assertEquals("patch-array", getOnlyRawContentBlock(messages.get(3)).get("tool_use_id").getAsString());
    }

    /** Restores immutable literal patch bindings used by the referenced Codex session. */
    @Test
    public void restoresPatchPassedThroughConstBinding() {
        String patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
        String literal = new com.google.gson.Gson().toJson(patch);
        for (String script : List.of("const patch = " + literal + "; text(await tools.apply_patch(patch));",
                "const patch = " + literal + "; text(await tools.apply_patch(patch)); text(await tools.exec_command({cmd:'pwd'}));")) {
            JsonArray records = new JsonArray();
            records.add(customToolCall("2026-10-02T00:00:00Z", "bound-patch", "exec", script));
            records.add(customToolCallOutput("2026-10-02T00:00:01Z", "bound-patch", "Script completed"));
            List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            JsonObject tool = getOnlyRawContentBlock(messages.get(0));
            assertEquals("apply_patch", tool.get("name").getAsString());
            assertEquals(patch, tool.getAsJsonObject("input").get("patch").getAsString());
            if (script.contains("exec_command")) {
                assertEquals("unknown", tool.getAsJsonObject("input").get("status").getAsString());
                assertEquals("exec", getOnlyRawContentBlock(messages.get(1)).get("name").getAsString());
            } else {
                assertEquals(tool.get("id"), getOnlyRawContentBlock(messages.get(1)).get("tool_use_id"));
            }
        }
    }

    /** Treats escaped template interpolation as literal source inside a patch. */
    @Test
    public void restoresPatchContainingEscapedTemplateExpression() {
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "escaped-template", "exec",
                "text(await tools.apply_patch(`*** Begin Patch\n*** Add File: a.ts\n+const value = \\${name};\n*** End Patch`));"));
        JsonObject tool = getOnlyRawContentBlock(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).get(0));
        assertEquals("apply_patch", tool.get("name").getAsString());
        assertTrue(tool.getAsJsonObject("input").get("patch").getAsString().contains("${name}"));
    }

    /** Includes unmatched replay inputs in retained state after visible messages have been flushed. */
    @Test
    public void accountsForUnmatchedReplayInputsAfterFlushingCards() {
        var accumulator = new HistoryMessageInjector.CodexFrontendMessageAccumulator(message -> { }, message -> { });
        String patch = "*** Begin Patch\n*** Add File: large.txt\n+" + "x".repeat(20_000) + "\n*** End Patch";
        accumulator.accept(customToolCall("2026-10-02T00:00:00Z", "held", "exec",
                "text(await tools.apply_patch(" + new com.google.gson.Gson().toJson(patch) + "));"));
        accumulator.accept(responseItemAssistantMessage("2026-10-02T00:00:01Z", "flushed previous card"));
        assertTrue(accumulator.retainedBytes() >= patch.length());
        accumulator.accept(customToolCallOutput("2026-10-02T00:00:02Z", "held", "success"));
        accumulator.accept(responseItemAssistantMessage("2026-10-02T00:00:03Z", "flushed result"));
        assertTrue(accumulator.retainedBytes() < patch.length());
    }
    /** Keeps dynamic scripts intact instead of losing calls or attributing a wrapper result to each tool. */
    @Test
    public void refusesPartialAndMixedExecReplay() {
        for (String script : List.of(
                "await tools.exec_command({cmd:'pwd'}); await tools.exec_command({cmd:dynamic});",
                "await tools.exec_command({cmd:'pwd', ...overrides});",
                "await tools.exec_command({cmd:'pwd', cmd:dynamic});",
                "const unrelated = {cmd:'pwd'}; await tools.shell_command(dynamic);",
                "const note = \"const cmds = [{command:'pwd'}]\"; const cmds = dynamic; await Promise.all(cmds.map(c => tools.shell_command(c)));",
                "await tools.update_plan({plan:[]}); await tools.exec_command({cmd:'pwd'});",
                "const patches = ['*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch',,]; for (const p of patches) text(await tools.apply_patch(p));",
                "const patches = ['*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch']; patches.push(dynamic); for (const p of patches) text(await tools.apply_patch(p));")) {
            JsonArray records = new JsonArray();
            records.add(customToolCall("2026-10-02T00:00:00Z", "opaque", "exec", script));
            records.add(customToolCallOutput("2026-10-02T00:00:01Z", "opaque", "combined output"));
            List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            assertEquals(script, 2, messages.size());
            assertEquals(script, "exec", getOnlyRawContentBlock(messages.get(0)).get("name").getAsString());
            assertTrue(messages.get(0).toString().contains("pwd") || messages.get(0).toString().contains("apply_patch"));
            assertEquals("opaque", getOnlyRawContentBlock(messages.get(1)).get("tool_use_id").getAsString());
        }
    }

    /** Previews every literal patch without assigning a shared wrapper outcome to any individual edit. */
    @Test
    public void previewsLiteralPatchesInsideMixedAndPartiallyDynamicWrappers() {
        String patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch";
        String literal = new com.google.gson.Gson().toJson(patch);
        for (String remainder : List.of("text(await tools.exec_command({cmd:'pwd'}));",
                "text(await tools.apply_patch(" + literal + "));", "await tools.apply_patch(dynamic);",
                "await tools.custom_lookup({value:1});")) {
            String script = "text(await tools.apply_patch(" + literal + ")); " + remainder;
            JsonArray records = new JsonArray();
            records.add(customToolCall("2026-10-02T00:00:00Z", "mixed-patch", "exec", script));
            records.add(customToolCallOutput("2026-10-02T00:00:01Z", "mixed-patch",
                    "Script failed\nScript error: apply_patch verification failed: Failed to find expected lines"));
            List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            int previewCount = remainder.contains(literal) ? 2 : 1;
            assertEquals(previewCount + 2, messages.size());
            for (int index = 0; index < previewCount; index++) {
                JsonObject preview = getOnlyRawContentBlock(messages.get(index));
                assertEquals("apply_patch", preview.get("name").getAsString());
                assertEquals(patch, preview.getAsJsonObject("input").get("patch").getAsString());
                assertEquals("unknown", preview.getAsJsonObject("input").get("status").getAsString());
            }
            JsonObject wrapper = getOnlyRawContentBlock(messages.get(previewCount));
            assertEquals("exec", wrapper.get("name").getAsString());
            assertEquals(script, wrapper.getAsJsonObject("input").get("patch").getAsString());
            JsonObject output = getOnlyRawContentBlock(messages.get(previewCount + 1));
            assertEquals("mixed-patch", output.get("tool_use_id").getAsString());
            assertTrue(output.get("is_error").getAsBoolean());
        }
    }

    /** Accepts literal Windows line endings without evaluating a historical script. */
    @Test
    public void restoresCrLfPatchAndStructuredFailure() {
        String patch = "*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch";
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "crlf", "exec",
                "text(await tools.apply_patch(" + new com.google.gson.Gson().toJson(patch) + "));"));
        records.add(customToolCallOutput("2026-10-02T00:00:01Z", "crlf",
                outputTextBlocks("Script completed", "{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"patch rejected\"}]}")));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals("apply_patch", getOnlyRawContentBlock(messages.get(0)).get("name").getAsString());
        assertEquals(patch, getOnlyRawContentBlock(messages.get(0)).getAsJsonObject("input").get("patch").getAsString());
        assertTrue(getOnlyRawContentBlock(messages.get(1)).get("is_error").getAsBoolean());
    }

    /** Ignores tool-looking source code inside a literal patch rather than treating it as an executed call. */
    @Test
    public void ignoresToolNamesInsidePatchText() {
        String patch = "*** Begin Patch\n*** Add File: example.js\n+tools.future_tool();\n*** End Patch";
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "quoted-tool", "exec",
                "text(await tools.apply_patch(" + new com.google.gson.Gson().toJson(patch) + "));"));
        JsonObject block = getOnlyRawContentBlock(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).get(0));
        assertEquals("apply_patch", block.get("name").getAsString());
        assertEquals(patch, block.getAsJsonObject("input").get("patch").getAsString());
    }

    /** Preserves distinct timed compactions even when legacy sources alternate without an intervening message. */
    @Test
    public void keepsDifferentTimedCompactions() {
        JsonArray records = new JsonArray();
        records.add(com.google.gson.JsonParser.parseString("{\"type\":\"event_msg\",\"timestamp\":\"2026-10-02T01:00:00Z\",\"payload\":{\"type\":\"context_compacted\"}}"));
        records.add(com.google.gson.JsonParser.parseString("{\"type\":\"compacted\",\"timestamp\":\"2026-10-02T02:00:00Z\",\"payload\":{\"message\":\"later summary\"}}"));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(2, messages.size());
        assertEquals("2026-10-02T01:00:00Z", messages.get(0).get("timestamp").getAsString());
        assertEquals("2026-10-02T02:00:00Z", messages.get(1).get("timestamp").getAsString());
    }

    /** Keeps literal command explanations while refusing to treat JavaScript expressions as text. */
    @Test
    public void restoresCommandSummaryAndApprovalJustification() {
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "command-meta", "exec",
                "text(await tools.exec_command({cmd:'git status',summary:'Inspect current changes',justification:'Access the workspace'}));"));
        JsonObject input = getOnlyRawContentBlock(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).get(0)).getAsJsonObject("input");
        assertEquals("Inspect current changes", input.get("description").getAsString());
        assertEquals("Access the workspace", input.get("justification").getAsString());
        records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "dynamic-cmd", "exec",
                "text(await tools.exec_command({cmd:commandVariable}));"));
        assertEquals("exec", getOnlyRawContentBlock(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).get(0)).get("name").getAsString());
    }
    /** Restores literal patches while preserving dynamic wrappers and failure outputs. */
    @Test
    public void restoresPatchFilesAndLeavesDynamicJavaScriptOpaque() {
        String patch = "*** Begin Patch\n*** Update File: E:/project/a.txt\n@@\n-old\n+new\n"
                + "*** Delete File: E:/project/old.txt\n*** End Patch";
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "patch", "functions.exec",
                "text(await tools.apply_patch(" + new com.google.gson.Gson().toJson(patch) + "));"));
        records.add(customToolCallOutput("2026-10-02T00:00:01Z", "patch", "Error: fixture failed"));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(2, messages.size());
        JsonObject tool = getOnlyRawContentBlock(messages.get(0));
        assertEquals("apply_patch", tool.get("name").getAsString());
        assertEquals(patch, tool.getAsJsonObject("input").get("patch").getAsString());
        assertEquals(tool.get("id"), getOnlyRawContentBlock(messages.get(1)).get("tool_use_id"));
        assertTrue(getOnlyRawContentBlock(messages.get(1)).get("is_error").getAsBoolean());
        for (String script : List.of("await tools.apply_patch(patch);",
                "const patch = buildPatch(); await tools.apply_patch(patch);",
                "const patch = '*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch' + suffix; await tools.apply_patch(patch);",
                "const patch = '*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch'; function run(patch) { tools.apply_patch(patch); }",
                "await tools.apply_patch(`*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`);",
                "await tools.apply_patch('*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch' + suffix);")) {
            JsonArray dynamic = new JsonArray();
            dynamic.add(customToolCall("2026-10-02T00:00:02Z", "dynamic", "exec", script));
            assertEquals("exec", getOnlyRawContentBlock(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(dynamic).get(0)).get("name").getAsString());
        }
    }

    /** Keeps each compact boundary once without replaying replacement model context. */
    @Test
    public void preservesCompactionTimesAndDeduplicatesOnlyLegacyCompanionEvents() {
        JsonArray records = new JsonArray();
        records.add(com.google.gson.JsonParser.parseString("""
                {"type":"compacted","timestamp":"2026-10-02T01:00:00Z","payload":{"message":"saved summary","replacement_history":[{"text":"MODEL-ONLY"}]}}
                """));
        records.add(com.google.gson.JsonParser.parseString("{\"type\":\"event_msg\",\"payload\":{\"type\":\"context_compacted\"}}"));
        records.add(com.google.gson.JsonParser.parseString("""
                {"type":"compacted","timestamp":"2026-10-02T02:00:00Z","payload":{"message":""}}
                """));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(2, messages.size());
        assertEquals("2026-10-02T01:00:00Z", messages.get(0).get("timestamp").getAsString());
        assertEquals("2026-10-02T02:00:00Z", messages.get(1).get("timestamp").getAsString());
        assertTrue(messages.get(1).getAsJsonObject("raw").get("isCompactSummary").getAsBoolean());
        assertFalse(messages.toString().contains("MODEL-ONLY"));
        assertFalse(messages.toString().contains("\"trigger\""));
        var nativePage = new HistoryMessageInjector.CodexHistoryPage();
        var legacyPage = new HistoryMessageInjector.CodexHistoryPage();
        legacyPage.messages = messages;
        assertTrue(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
        nativePage.messages = messages.stream().map(message -> {
            JsonObject approximate = message.deepCopy();
            approximate.getAsJsonObject("raw").getAsJsonObject("summarizeMetadata").addProperty("timestampSource", "turn");
            return approximate;
        }).toList();
        assertTrue(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
    }
    @Test
    public void nativeProjectionWithSomeToolsStillFallsBackWhenOtherStoredToolsAreMissing() {
        var nativePage = new HistoryMessageInjector.CodexHistoryPage();
        var legacyPage = new HistoryMessageInjector.CodexHistoryPage();
        JsonObject one = com.google.gson.JsonParser.parseString("""
                {"type":"assistant","raw":{"content":[{"type":"tool_use","id":"one"}]}}
                """).getAsJsonObject();
        JsonObject two = one.deepCopy();
        two.getAsJsonObject("raw").getAsJsonArray("content").add(
                com.google.gson.JsonParser.parseString("{\"type\":\"tool_use\",\"id\":\"two\"}"));
        nativePage.messages.add(one);
        legacyPage.messages.add(two);
        assertTrue(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
        legacyPage.messages = List.of(one);
        assertFalse(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
        nativePage.messages = List.of(one.deepCopy());
        one.getAsJsonObject("raw").add("usage", new JsonObject());
        assertTrue(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
    }
    /** Extra native exec cards must not beat an independently restored projection merely by increasing the count. */
    @Test
    public void prefersTheProjectionThatAlreadyRestoredThisExactWrapper() {
        var nativePage = new HistoryMessageInjector.CodexHistoryPage();
        var legacyPage = new HistoryMessageInjector.CodexHistoryPage();
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-03T00:00:00Z", "known", "exec",
                "text(await tools.exec_command({cmd:'npm test'}));"));
        records.add(customToolCallOutput("2026-10-03T00:00:01Z", "known", "{\"exit_code\":0,\"output\":\"passed\"}"));
        legacyPage.messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        JsonObject extra = com.google.gson.JsonParser.parseString("""
                {"type":"assistant","raw":{"message":{"content":[{"type":"tool_use","id":"known","name":"exec"}]}}}
                """).getAsJsonObject();
        nativePage.messages.addAll(legacyPage.messages);
        nativePage.messages.add(extra);
        assertTrue(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
        extra.getAsJsonObject("raw").getAsJsonObject("message").getAsJsonArray("content")
                .get(0).getAsJsonObject().addProperty("id", "unrelated");
        assertFalse(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
        records.remove(records.size() - 1);
        legacyPage.messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        extra.getAsJsonObject("raw").getAsJsonObject("message").getAsJsonArray("content")
                .get(0).getAsJsonObject().addProperty("id", "known");
        assertFalse(HistoryMessageInjector.requiresLegacyProjection(nativePage, legacyPage));
    }

    @Test
    public void mixedExecWrapperRetainsUnsupportedWorkAndItsOutput() {
        JsonArray records = new JsonArray();
        records.add(customToolCall("2026-10-02T00:00:00Z", "mixed", "functions.exec",
                "await tools.exec_command({cmd:'pwd'}); await tools.custom_lookup({value:1});"));
        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(1, result.size());
        assertTrue(result.toString().contains("custom_lookup"));
        assertTrue(result.toString().contains("functions.exec"));
    }

    @Test
    public void staleGenerationCannotPublishMessagesOrCompletion() {
        HistoryMessageInjector injector = new HistoryMessageInjector(null);
        long previous = injector.invalidateCodexHistory();
        long current = injector.invalidateCodexHistory();
        java.util.concurrent.atomic.AtomicInteger publications = new java.util.concurrent.atomic.AtomicInteger();
        injector.publishIfCurrent(previous, publications::incrementAndGet);
        assertEquals(0, publications.get());
        injector.publishIfCurrent(current, publications::incrementAndGet);
        assertEquals(1, publications.get());
    }

    @Test
    public void handleLoadSessionUsesPayloadProviderAndResolvedCodexSessionId() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        boolean[] callbackInvoked = {false};

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-codex\",\"provider\":\"codex\"}",
                "claude",
                (sessionId, projectPath, provider, model) -> callbackInvoked[0] = true
        );

        assertEquals("hist-codex", injector.loadedCodexSessionId);
        assertFalse(callbackInvoked[0]);
    }

    @Test
    public void handleLoadSessionUsesPayloadProviderForClaudeEvenWhenCurrentProviderIsCodex() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        String[] callbackArgs = new String[4];

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-claude\",\"provider\":\"claude\",\"model\":\"claude-sonnet-4-6\"}",
                "codex",
                (sessionId, projectPath, provider, model) -> {
                    callbackArgs[0] = sessionId;
                    callbackArgs[1] = projectPath;
                    callbackArgs[2] = provider;
                    callbackArgs[3] = model;
                }
        );

        assertNull(injector.loadedCodexSessionId);
        assertEquals("hist-claude", callbackArgs[0]);
        assertEquals("D:/project/demo", callbackArgs[1]);
        assertEquals("claude", callbackArgs[2]);
        assertEquals("claude-sonnet-4-6", callbackArgs[3]);
    }

    @Test
    public void handleLoadSessionCompletesHistoryLoadWhenProjectPathMissing() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext(null));
        boolean[] callbackInvoked = {false};

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-codex\",\"provider\":\"codex\"}",
                "claude",
                (sessionId, projectPath, provider, model) -> callbackInvoked[0] = true
        );

        assertNull(injector.loadedCodexSessionId);
        assertFalse(callbackInvoked[0]);
        assertEquals(1, injector.historyLoadCompleteCount);
    }

    @Test
    public void handleLoadSessionCompletesHistoryLoadWhenClaudeCallbackMissing() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-claude\",\"provider\":\"claude\"}",
                "codex",
                null
        );

        assertNull(injector.loadedCodexSessionId);
        assertEquals(1, injector.historyLoadCompleteCount);
    }

    @Test
    public void convertCodexMessagesDeduplicatesDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("user", result.get(0).get("type").getAsString());
        assertEquals("hello", result.get(0).get("content").getAsString());
    }

    @Test
    public void restoresIsoTimestampWhenHydratingCodexMessagesIntoSessionState() {
        JsonObject frontendMessage = frontendMessage("assistant", "done", "text");
        frontendMessage.addProperty("timestamp", "2026-07-28T12:50:07.123Z");

        ClaudeSession.Message restored = HistoryMessageInjector.toSessionMessage(frontendMessage);

        assertEquals(1785243007123L, restored.timestamp);
    }

    @Test
    public void restoresNumericStringTimestampWhenHydratingSessionState() {
        JsonObject frontendMessage = frontendMessage("user", "hello", "text");
        frontendMessage.addProperty("timestamp", "1785243007123");

        ClaudeSession.Message restored = HistoryMessageInjector.toSessionMessage(frontendMessage);

        assertEquals(1785243007123L, restored.timestamp);
    }

    @Test
    public void convertCodexMessagesDeduplicatesDualRecordedUserMessageWithDifferentTimestamps() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:27.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
    }

    @Test
    public void convertCodexMessagesKeepsTwoIdenticalUserTurnsWithoutAssistantBetweenThem() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:27.701Z", "hello"));
        messages.add(responseItemUserMessage("2026-04-30T09:40:28.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:29.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
    }

    @Test
    public void convertCodexMessagesDeduplicatesImageWrappedDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "<image name=[Image #1]>\n</image>\nhello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("hello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesStripsAgentsInstructionsFromDuplicatedUserMessage() {
        String text = "<agents-instructions>\n"
                + "# Global Instructions\n\n"
                + "请默认使用中文（简体）回复。\n"
                + "</agents-instructions>\n\n"
                + "hello";
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", text));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", text));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("hello", result.get(0).get("content").getAsString());
        assertEquals("hello", result.get(0)
                .getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject()
                .get("text")
                .getAsString());
    }

    @Test
    public void convertCodexMessagesRestoresLocalImagesFromEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:02:20.861Z", "hello", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("image/png", contentBlocks.get(0).getAsJsonObject().get("mediaType").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("hello", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesFiltersDeveloperRoleMessages() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemDeveloperMessage("2026-05-14T10:00:00.000Z", "internal developer instructions"));
        messages.add(responseItemAssistantMessage("2026-05-14T10:00:01.000Z", "visible assistant reply"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("assistant", result.get(0).get("type").getAsString());
        assertEquals("visible assistant reply", result.get(0).get("content").getAsString());
    }

    /**
     * Verifies that batch history conversion attaches the latest Codex context snapshot
     * and provider-reported window to the preceding assistant message.
     */
    @Test
    public void convertCodexMessagesPreservesTokenCountContextWindow() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemAssistantMessage("2026-05-14T10:00:01.000Z", "visible assistant reply"));
        messages.add(tokenCountEvent(
                "2026-05-14T10:00:02.000Z", 500000, 9000, 12000, 345, 258400));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        JsonObject usage = result.get(0).getAsJsonObject("raw").getAsJsonObject("usage");
        assertEquals(12000, usage.get("input_tokens").getAsInt());
        assertEquals(345, usage.get("output_tokens").getAsInt());
        assertEquals(258400, usage.get("model_context_window").getAsInt());
    }

    /**
     * Verifies history containing only session-cumulative usage leaves the current
     * context unknown instead of attaching a value that can exceed the model window.
     */
    @Test
    public void convertCodexMessagesIgnoresTotalUsageWithoutLastUsage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemAssistantMessage("2026-05-14T10:00:01.000Z", "visible assistant reply"));
        messages.add(tokenCountEvent("2026-05-14T10:00:02.000Z", 12000, 345, 258400));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertFalse(result.get(0).getAsJsonObject("raw").has("usage"));
    }

    /**
     * Verifies the production streaming history scanner, rather than only batch
     * conversion, preserves token_count metadata during real pagination.
     */
    @Test
    public void scanCodexHistoryPagePreservesTokenCountContextWindow() throws Exception {
        JsonArray messages = new JsonArray();
        messages.add(eventUserMessage("2026-05-14T10:00:00.000Z", "question"));
        messages.add(responseItemAssistantMessage("2026-05-14T10:00:01.000Z", "answer"));
        messages.add(tokenCountEvent(
                "2026-05-14T10:00:02.000Z", 500000, 9000, 12000, 345, 258400));
        CodexHistoryReader reader = new CodexHistoryReader() {
            @Override
            public int forEachSessionMessage(
                    String sessionId,
                    java.util.function.Consumer<JsonObject> consumer
            ) {
                for (JsonElement message : messages) {
                    consumer.accept(message.getAsJsonObject());
                }
                return messages.size();
            }
        };

        HistoryMessageInjector.CodexHistoryPage page =
                HistoryMessageInjector.scanCodexHistoryPage(reader, "fixture-session", null, 30);

        assertEquals(2, page.messages.size());
        JsonObject usage = page.messages.get(1)
                .getAsJsonObject("raw").getAsJsonObject("usage");
        assertEquals(12000, usage.get("input_tokens").getAsInt());
        assertEquals(345, usage.get("output_tokens").getAsInt());
        assertEquals(258400, usage.get("model_context_window").getAsInt());
    }

    @Test
    public void convertCodexMessagesReplaysBatchExecAsOriginalCommandGroup() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "exec-call",
                "exec",
                "const cmds = [\n"
                    + "  {command:\"\\\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell"
                    + "\\\\v1.0\\\\powershell.exe\\\" -Command \\\"Write-Output one\\\"\","
                    + "workdir:\"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\demo\",timeout_ms:10000},\n"
                    + "  {command:'echo second',workdir:'D:/demo',timeout_ms:10000},\n"
                    + "  {command:\"npm test\",workdir:\"D:/demo\",timeout_ms:10000}\n"
                    + "];\n"
                    + "const results = await Promise.all(cmds.map(c => tools.shell_command(c)));\n"
                    + "results.forEach((r,i)=>{ text(`---${i+1}---`); text(r); });"
        ));
        messages.add(customToolCallOutput(
                "2026-07-23T02:00:01.000Z",
                "exec-call",
                outputTextBlocks(
                        "Script completed\nWall time 1.2 seconds\nOutput:\n",
                        "---1---",
                        "Exit code: 0\nWall time: 0.2 seconds\nOutput:\none",
                        "---2---",
                        "Exit code: 0\nWall time: 0.2 seconds\nOutput:\nsecond",
                        "---3---",
                        "Script error:\nExit code: 1\nWall time: 0.2 seconds\nOutput:\ntests failed"
                )
        ));
        messages.add(functionCall("2026-07-23T02:00:02.000Z", "wait-call", "wait",
                "{\"cell_id\":5,\"terminate\":true,\"max_tokens\":10000}"));
        messages.add(functionCallOutput("2026-07-23T02:00:03.000Z", "wait-call", "completed"));
        messages.add(responseItemAssistantMessage("2026-07-23T02:00:04.000Z", "visible assistant reply"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(5, result.size());
        JsonArray toolUses = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(3, toolUses.size());
        assertEquals("tool_use", toolUses.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("bash", toolUses.get(0).getAsJsonObject().get("name").getAsString());
        assertEquals("bash", toolUses.get(1).getAsJsonObject().get("name").getAsString());
        assertEquals("bash", toolUses.get(2).getAsJsonObject().get("name").getAsString());
        JsonObject firstInput = toolUses.get(0).getAsJsonObject().getAsJsonObject("input");
        assertTrue(firstInput.get("command").getAsString().startsWith("\"C:\\Windows\\System32"));
        assertTrue(firstInput.get("description").getAsString().startsWith("Run \"C:\\Windows"));
        assertEquals("\\\\wsl.localhost\\Ubuntu\\home\\demo", firstInput.get("workdir").getAsString());
        assertEquals(10000, firstInput.get("timeout_ms").getAsInt());

        JsonArray toolResults = result.get(1).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(3, toolResults.size());
        assertFalse(toolResults.get(0).getAsJsonObject().get("is_error").getAsBoolean());
        assertFalse(toolResults.get(1).getAsJsonObject().get("is_error").getAsBoolean());
        assertTrue(toolResults.get(2).getAsJsonObject().get("is_error").getAsBoolean());
        assertTrue(toolResults.get(0).getAsJsonObject().get("content").getAsString().contains("one"));
        assertEquals(
                toolUses.get(2).getAsJsonObject().get("id").getAsString(),
                toolResults.get(2).getAsJsonObject().get("tool_use_id").getAsString()
        );
        assertEquals("visible assistant reply", result.get(4).get("content").getAsString());
        assertFalse(result.toString().contains("const cmds"));
        assertEquals("wait", getOnlyRawContentBlock(result.get(2)).get("name").getAsString());
    }

    @Test
    public void convertCodexMessagesReplaysSingleExecWithLiveDescriptionAndResult() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "exec-1",
                "exec",
                "const r = await tools.shell_command({"
                    + "command:'git status',workdir:'D:/demo',timeout_ms:5000"
                    + "}); text(r);"
        ));
        messages.add(customToolCallOutput(
                "2026-07-23T02:00:01.000Z",
                "exec-1",
                outputTextBlocks(
                        "Script completed\nWall time 0.2 seconds\nOutput:\n",
                        "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nOn branch main"
                )
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
        JsonObject toolUse = getOnlyRawContentBlock(result.get(0));
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("bash", toolUse.get("name").getAsString());
        assertEquals("git status", toolUse.getAsJsonObject("input").get("command").getAsString());
        assertEquals("Check git status", toolUse.getAsJsonObject("input").get("description").getAsString());
        JsonObject toolResult = getOnlyRawContentBlock(result.get(1));
        assertFalse(toolResult.get("is_error").getAsBoolean());
        assertTrue(toolResult.get("content").getAsString().contains("On branch main"));
    }

    @Test
    public void convertCodexMessagesReplaysNestedUpdatePlan() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "plan-1",
                "exec",
                "const r = await tools.update_plan({"
                    + "explanation:\"Implement and verify\","
                    + "plan:["
                    + "{step:\"Inspect current behavior\",status:\"completed\"},"
                    + "{step:'Implement parser',status:'in_progress'},"
                    + "{step:`Run tests`,status:\"pending\"}"
                    + "]}); text(r);"
        ));
        messages.add(customToolCallOutput("2026-07-23T02:00:01.000Z", "plan-1", "{}"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
        JsonObject toolUse = getOnlyRawContentBlock(result.get(0));
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("todowrite", toolUse.get("name").getAsString());
        assertEquals("codex_plan_plan-1", toolUse.get("id").getAsString());
        JsonArray todos = toolUse.getAsJsonObject("input").getAsJsonArray("todos");
        assertEquals(3, todos.size());
        assertEquals("Inspect current behavior", todos.get(0).getAsJsonObject().get("content").getAsString());
        assertEquals("completed", todos.get(0).getAsJsonObject().get("status").getAsString());
        assertEquals("Implement parser", todos.get(1).getAsJsonObject().get("content").getAsString());
        assertEquals("in_progress", todos.get(1).getAsJsonObject().get("status").getAsString());
        JsonObject toolResult = getOnlyRawContentBlock(result.get(1));
        assertEquals("codex_plan_plan-1", toolResult.get("tool_use_id").getAsString());
        assertFalse(toolResult.get("is_error").getAsBoolean());
    }

    @Test
    public void convertCodexMessagesReplaysOnlyTopLevelPlanItems() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "plan-literal",
                "exec",
                "await tools.update_plan({plan:["
                    + "{step:'Keep this item',status:'pending',metadata:{content:'Not a task'}}"
                    + "]});"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        JsonArray todos = getOnlyRawContentBlock(result.get(0))
                .getAsJsonObject("input").getAsJsonArray("todos");
        assertEquals(1, todos.size());
        assertEquals("Keep this item", todos.get(0).getAsJsonObject().get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesRejectsDynamicUpdatePlanExpressions() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "plan-dynamic",
                "exec",
                "await tools.update_plan({plan:[{step:buildStep(),status:'pending'}]});"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals("exec", getOnlyRawContentBlock(result.get(0)).get("name").getAsString());
    }

    @Test
    public void convertCodexMessagesDoesNotFallBackFromDynamicLatestPlan() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "plan-latest-dynamic",
                "exec",
                "await tools.update_plan({plan:[{step:'Old',status:'pending'}]});"
                    + "await tools.update_plan({plan:[{step:buildStep(),status:'pending'}]});"
        ));
        messages.add(customToolCall(
                "2026-07-23T02:00:01.000Z",
                "plan-other-object",
                "exec",
                "await other.tools.update_plan({plan:[{step:'Injected',status:'pending'}]});"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
        assertFalse(result.toString().contains("\"name\":\"todowrite\""));
    }

    @Test
    public void convertCodexMessagesIgnoresUpdatePlanTextInStringsAndComments() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "plan-docs",
                "exec",
                "const example = \"tools.update_plan({plan:[{step:'Fake'}]})\";"
                    + "// tools.update_plan({plan:[{step:'Fake'}]})\n"
                    + "/* tools.update_plan({plan:[{step:'Fake'}]}) */"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals("exec", getOnlyRawContentBlock(result.get(0)).get("name").getAsString());
    }

    @Test
    public void convertCodexMessagesPreservesEmptyUpdatePlanSnapshot() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "plan-empty",
                "exec",
                "await tools.update_plan({ /* clear */ plan: [], });"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        JsonObject toolUse = getOnlyRawContentBlock(result.get(0));
        assertEquals("todowrite", toolUse.get("name").getAsString());
        assertTrue(toolUse.getAsJsonObject("input").getAsJsonArray("todos").isEmpty());
    }

    @Test
    public void convertCodexMessagesKeepsUnprojectedExecAndWaitCards() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "patch-wrapper",
                "exec",
                "await tools.apply_patch('*** Begin Patch\\n*** End Patch');"
        ));
        messages.add(customToolCallOutput("2026-07-23T02:00:01.000Z", "patch-wrapper", "completed"));
        messages.add(functionCall("2026-07-23T02:00:02.000Z", "wait-running", "wait",
                "{\"cell_id\":9,\"terminate\":false,\"max_tokens\":10000}"));
        messages.add(responseItemAssistantMessage("2026-07-23T02:00:03.000Z", "done"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(4, result.size());
        assertEquals("done", result.get(3).get("content").getAsString());
        assertEquals("exec", getOnlyRawContentBlock(result.get(0)).get("name").getAsString());
        assertEquals("wait", getOnlyRawContentBlock(result.get(2)).get("name").getAsString());
    }

    @Test
    public void convertCodexMessagesKeepsImageOnlyEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image-only", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:03:20.861Z", "", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            assertEquals("", result.get(0).get("content").getAsString());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(1, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesStripsAppendedProjectModulesContext() {
        JsonArray messages = new JsonArray();
        messages.add(eventUserMessage(
                "2026-05-11T09:03:20.861Z",
                "只保留用户输入\n\n## Project Modules\n\nThis project contains multiple modules:\n- `idea-claude-code-gui`\n"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("只保留用户输入", result.get(0).get("content").getAsString());
        JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(1, contentBlocks.size());
        assertEquals("只保留用户输入", contentBlocks.get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void paginatesCompleteCodexTurnsWithoutPermanentlyDroppingEarlierHistory() {
        JsonArray history = createTurnHistory(65);

        HistoryMessageInjector.CodexHistoryPage latest =
                HistoryMessageInjector.paginateCodexMessages(history, null, 30);
        HistoryMessageInjector.CodexHistoryPage previous =
                HistoryMessageInjector.paginateCodexMessages(history, latest.fromTurn, 30);
        HistoryMessageInjector.CodexHistoryPage first =
                HistoryMessageInjector.paginateCodexMessages(history, previous.fromTurn, 30);

        assertEquals(65, latest.totalTurns);
        assertEquals(35, latest.fromTurn);
        assertEquals(65, latest.toTurn);
        assertEquals("user-35", latest.messages.get(0).get("content").getAsString());
        assertEquals("assistant-64", latest.messages.get(latest.messages.size() - 1).get("content").getAsString());

        assertEquals(5, previous.fromTurn);
        assertEquals(35, previous.toTurn);
        assertEquals("user-5", previous.messages.get(0).get("content").getAsString());

        assertEquals(0, first.fromTurn);
        assertEquals(5, first.toTurn);
        assertEquals("user-0", first.messages.get(0).get("content").getAsString());
        assertEquals("assistant-4", first.messages.get(first.messages.size() - 1).get("content").getAsString());
    }

    @Test
    public void resetsToLatestPageWhenCodexHistoryCursorExceedsCurrentFile() {
        HistoryMessageInjector.CodexHistoryPage page =
                HistoryMessageInjector.paginateCodexMessages(createTurnHistory(40), 60, 30);

        assertTrue(page.cursorReset);
        assertEquals(10, page.fromTurn);
        assertEquals(40, page.toTurn);
        assertEquals("user-10", page.messages.get(0).get("content").getAsString());
    }

    @Test
    public void convertsCustomToolCallOutputToToolResult() {
        JsonArray history = new JsonArray();
        history.add(responseItemCustomToolOutput("2026-04-30T09:40:26.701Z", "call-1", "tool output"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(history);

        assertEquals(1, result.size());
        JsonObject block = result.get(0).getAsJsonObject("raw")
                .getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_result", block.get("type").getAsString());
        assertEquals("call-1", block.get("tool_use_id").getAsString());
        assertEquals("tool output", block.get("content").getAsString());
    }

    @Test
    public void partitionsHistoryByMessageCountAndTargetPayloadSize() {
        List<JsonObject> messages = new java.util.ArrayList<>();
        for (int i = 0; i < 120; i++) {
            messages.add(frontendMessage(
                    i % 2 == 0 ? "user" : "assistant",
                    "message-" + i + "-" + "x".repeat(4000),
                    "text"));
        }

        List<List<JsonObject>> batches = HistoryMessageInjector.partitionHistoryMessages(messages);

        assertTrue(batches.size() > 2);
        assertEquals(120, batches.stream().mapToInt(List::size).sum());
        for (List<JsonObject> batch : batches) {
            assertTrue(batch.size() <= HistoryMessageInjector.HISTORY_BATCH_MESSAGE_LIMIT);
            assertTrue(com.github.claudecodegui.util.JsUtils.escapeJs(
                    new com.google.gson.Gson().toJson(batch)).length()
                    <= HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT);
        }
    }

    @Test
    public void oversizedSingleMessageIsNotDroppedByPartitioning() {
        JsonObject oversized = frontendMessage(
                "user",
                "x".repeat(HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT + 1),
                "text");

        List<List<JsonObject>> batches = HistoryMessageInjector.partitionHistoryMessages(List.of(oversized));

        assertEquals(1, batches.size());
        assertEquals(1, batches.get(0).size());
        assertEquals(oversized, batches.get(0).get(0));

        String payload = new com.google.gson.Gson().toJson(batches.get(0));
        List<String> chunks = HistoryMessageInjector.splitHistoryPayload(payload);
        assertTrue(chunks.size() > 1);
        assertEquals(payload, String.join("", chunks));
        for (String chunk : chunks) {
            assertTrue(com.github.claudecodegui.util.JsUtils.escapeJs(chunk).length()
                    <= HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT);
        }
    }

    @Test
    public void payloadChunksPreserveUnicodeAndStayWithinEscapedLimit() {
        String payload = ("\u2028😃</script>'\"\\").repeat(20_000);

        List<String> chunks = HistoryMessageInjector.splitHistoryPayload(payload);

        assertTrue(chunks.size() > 1);
        assertEquals(payload, String.join("", chunks));
        for (String chunk : chunks) {
            assertTrue(com.github.claudecodegui.util.JsUtils.escapeJs(chunk).length()
                    <= HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT);
            if (!chunk.isEmpty()) {
                assertFalse(Character.isHighSurrogate(chunk.charAt(chunk.length() - 1)));
                assertFalse(Character.isLowSurrogate(chunk.charAt(0)));
            }
        }
    }

    private static JsonObject frontendMessage(String type, String content, String blockType) {
        JsonObject message = new JsonObject();
        message.addProperty("type", type);
        message.addProperty("content", content);
        JsonObject raw = new JsonObject();
        JsonArray blocks = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", blockType);
        blocks.add(block);
        raw.add("content", blocks);
        message.add("raw", raw);
        return message;
    }

    private static JsonObject responseItemUserMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "user", "input_text", text);
    }

    private static JsonObject responseItemDeveloperMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "developer", "text", text);
    }

    private static JsonObject responseItemAssistantMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "assistant", "output_text", text);
    }

    private static JsonObject responseItemCustomToolOutput(String timestamp, String callId, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call_output");
        payload.addProperty("call_id", callId);
        JsonArray output = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "input_text");
        block.addProperty("text", text);
        output.add(block);
        payload.add("output", output);
        line.add("payload", payload);
        return line;
    }

    private static JsonArray createTurnHistory(int turnCount) {
        JsonArray history = new JsonArray();
        for (int i = 0; i < turnCount; i++) {
            String timestamp = "2026-04-30T09:40:" + i + ".001Z";
            history.add(responseItemUserMessage(timestamp, "user-" + i));
            history.add(eventUserMessage(timestamp, "user-" + i));
            history.add(responseItemAssistantMessage(timestamp, "assistant-" + i));
        }
        return history;
    }

    private static JsonObject responseItemMessage(String timestamp, String role, String blockType, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "message");
        payload.addProperty("role", role);

        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", blockType);
        block.addProperty("text", text);
        content.add(block);

        payload.add("content", content);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "event_msg");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "user_message");
        payload.addProperty("message", text);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text, String localImagePath) {
        JsonObject line = eventUserMessage(timestamp, text);
        JsonArray localImages = new JsonArray();
        localImages.add(localImagePath);
        line.getAsJsonObject("payload").add("local_images", localImages);
        return line;
    }

    private static JsonObject tokenCountEvent(
            String timestamp,
            int inputTokens,
            int outputTokens,
            int contextWindow
    ) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "event_msg");

        JsonObject totalUsage = new JsonObject();
        totalUsage.addProperty("input_tokens", inputTokens);
        totalUsage.addProperty("output_tokens", outputTokens);
        totalUsage.addProperty("cached_input_tokens", 0);

        JsonObject info = new JsonObject();
        info.add("total_token_usage", totalUsage);
        info.addProperty("model_context_window", contextWindow);

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "token_count");
        payload.add("info", info);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject tokenCountEvent(
            String timestamp,
            int totalInputTokens,
            int totalOutputTokens,
            int lastInputTokens,
            int lastOutputTokens,
            int contextWindow
    ) {
        JsonObject line = tokenCountEvent(timestamp, totalInputTokens, totalOutputTokens, contextWindow);
        JsonObject lastUsage = new JsonObject();
        lastUsage.addProperty("input_tokens", lastInputTokens);
        lastUsage.addProperty("output_tokens", lastOutputTokens);
        lastUsage.addProperty("cached_input_tokens", 0);
        line.getAsJsonObject("payload").getAsJsonObject("info").add("last_token_usage", lastUsage);
        return line;
    }

    private static JsonObject functionCall(
            String timestamp,
            String callId,
            String name,
            String arguments
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("call_id", callId);
        payload.addProperty("name", name);
        payload.addProperty("arguments", arguments);
        return responseItem(timestamp, payload);
    }

    private static JsonObject functionCallOutput(String timestamp, String callId, String output) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call_output");
        payload.addProperty("call_id", callId);
        payload.addProperty("output", output);
        return responseItem(timestamp, payload);
    }

    private static JsonObject customToolCall(
            String timestamp,
            String callId,
            String name,
            String input
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call");
        payload.addProperty("call_id", callId);
        payload.addProperty("name", name);
        payload.addProperty("input", input);
        return responseItem(timestamp, payload);
    }

    private static JsonObject customToolCallOutput(String timestamp, String callId, String output) {
        return customToolCallOutput(timestamp, callId, new JsonPrimitive(output));
    }

    private static JsonObject customToolCallOutput(
            String timestamp,
            String callId,
            JsonElement output
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call_output");
        payload.addProperty("call_id", callId);
        payload.add("output", output);
        return responseItem(timestamp, payload);
    }

    private static JsonArray outputTextBlocks(String... texts) {
        JsonArray blocks = new JsonArray();
        for (String text : texts) {
            JsonObject block = new JsonObject();
            block.addProperty("type", "input_text");
            block.addProperty("text", text);
            blocks.add(block);
        }
        return blocks;
    }

    private static JsonObject responseItem(String timestamp, JsonObject payload) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");
        line.add("payload", payload);
        return line;
    }

    private static JsonObject getOnlyRawContentBlock(JsonObject frontendMessage) {
        JsonArray blocks = frontendMessage.getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(1, blocks.size());
        return blocks.get(0).getAsJsonObject();
    }

    private static HandlerContext createContext(String basePath) {
        Project project = (Project) Proxy.newProxyInstance(
                HistoryMessageInjectorTest.class.getClassLoader(),
                new Class[]{Project.class},
                (proxy, method, args) -> {
                    if ("getBasePath".equals(method.getName())) {
                        return basePath;
                    }
                    if ("isDisposed".equals(method.getName())) {
                        return false;
                    }
                    Class<?> returnType = method.getReturnType();
                    if (returnType.equals(boolean.class)) {
                        return false;
                    }
                    if (returnType.equals(int.class)) {
                        return 0;
                    }
                    if (returnType.equals(long.class)) {
                        return 0L;
                    }
                    return null;
                }
        );

        return new HandlerContext(project, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    private static final class RecordingHistoryMessageInjector extends HistoryMessageInjector {
        private String loadedCodexSessionId;
        private int historyLoadCompleteCount;

        private RecordingHistoryMessageInjector(HandlerContext context) {
            super(context);
        }

        @Override
        void loadCodexSession(String sessionId) {
            loadCodexSession(sessionId, null);
        }

        @Override
        void loadCodexSession(String sessionId, String model) {
            this.loadedCodexSessionId = sessionId;
        }

        @Override
        void notifyHistoryLoadComplete() {
            historyLoadCompleteCount++;
        }
    }
}
