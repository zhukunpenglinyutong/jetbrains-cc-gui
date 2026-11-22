package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class CodexHistoryPageIndexTest {
    /** Appending a cross-turn wait response preserves its request's original turn in cached pages. */
    @Test
    public void pagedWaitKeepsItsArrivalTurnAcrossAppend() throws Exception {
        Files.writeString(this.session, user("inspect") + """
                {"type":"session_meta","payload":{"id":"thread"}}
                {"type":"turn_context","payload":{"turn_id":"first-turn"}}
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"yielded","input":"await tools[load('tool')](load('args'));"}}
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"yielded","output":[{"type":"input_text","text":"Script running with cell ID cell-1\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                {"type":"turn_context","payload":{"turn_id":"waiting-turn"}}
                {"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":"wait-1","arguments":"{\\"cell_id\\":\\"cell-1\\"}"}}
                """);
        for (boolean completed : java.util.List.of(false, true)) {
            if (completed) {
                Files.writeString(this.session, """
                        {"type":"turn_context","payload":{"turn_id":"reply-turn"}}
                        {"type":"response_item","payload":{"type":"function_call_output","call_id":"wait-1","output":[{"type":"input_text","text":"Script completed\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                        """, StandardOpenOption.APPEND);
            }
            var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                    this.reader.getSessionMessagesAsJson("fixture"), JsonArray.class));
            var waits = full.stream().filter(message -> message.toString().contains("wait-1")).toList();
            assertEquals(completed ? 2 : 1, waits.size());
            assertEquals("waiting-turn", HistoryMessageInjector.getStringProperty(waits.get(0).getAsJsonObject("raw"), "codexTurnId"));
            if (completed) {
                assertEquals("reply-turn", HistoryMessageInjector.getStringProperty(waits.get(1).getAsJsonObject("raw"), "codexTurnId"));
            }
            assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
            assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        }
    }

    /** Buffered usage remains attached to the same assistant before and after a yielded cell finishes. */
    @Test
    public void pagedBufferedUsageKeepsItsAssistantAcrossAppend() throws Exception {
        Files.writeString(this.session, user("inspect") + """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"yielded","input":"text(await tools.exec_command({cmd:'npm test'}));"}}
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"yielded","output":[{"type":"input_text","text":"Script running with cell ID cell-1\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                {"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":123,"output_tokens":7},"model_context_window":200000}}}
                """);
        for (boolean completed : java.util.List.of(false, true)) {
            if (completed) {
                Files.writeString(this.session, """
                        {"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":"wait-1","arguments":"{\\"cell_id\\":\\"cell-1\\"}"}}
                        {"type":"response_item","payload":{"type":"function_call_output","call_id":"wait-1","output":[{"type":"input_text","text":"Script completed\\nWall time 0.1 seconds\\nOutput:\\n"},{"type":"input_text","text":"{\\"exit_code\\":0,\\"output\\":\\"passed\\"}"}]}}
                        """, StandardOpenOption.APPEND);
            }
            var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                    this.reader.getSessionMessagesAsJson("fixture"), JsonArray.class));
            assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
            assertEquals(1, full.stream().filter(message -> message.getAsJsonObject("raw").has("usage")).count());
            assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        }
    }

    /** A cross-turn background completion keeps its own outcome when an indexed continuation falls back. */
    @Test
    public void pagedContinuationKeepsForeignReceiptsAcrossAppend() throws Exception {
        Files.writeString(this.session, user("inspect") + """
                {"type":"session_meta","payload":{"id":"thread"}}
                {"type":"turn_context","payload":{"turn_id":"first-turn"}}
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"yielded","input":"await tools.exec_command({cmd:'npm test'});await tools.exec_command({cmd:'npm run build'});"}}
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"first-turn","item":{"type":"CommandExecution","id":"first","command":"npm test","status":"completed","exit_code":0,"aggregated_output":"first passed"}}}
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"yielded","output":[{"type":"input_text","text":"Script running with cell ID cell-1\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                """);
        this.index.read(this.reader, "fixture", null, 30, () -> true);
        Files.writeString(this.session, """
                {"type":"turn_context","payload":{"turn_id":"next-turn"}}
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"next-turn","item":{"type":"CommandExecution","id":"second","command":"npm run build","status":"completed","exit_code":0,"aggregated_output":"second passed"}}}
                """, StandardOpenOption.APPEND);
        for (boolean completed : java.util.List.of(false, true)) {
            if (completed) {
                Files.writeString(this.session, """
                        {"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":"wait-1","arguments":"{\\"cell_id\\":\\"cell-1\\"}"}}
                        {"type":"response_item","payload":{"type":"function_call_output","call_id":"wait-1","output":[{"type":"input_text","text":"Script completed\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                        """, StandardOpenOption.APPEND);
            }
            var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                    this.reader.getSessionMessagesAsJson("fixture"), JsonArray.class));
            assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
            assertTrue(full.stream().anyMatch(message -> message.toString().contains("second passed")
                    && "next-turn".equals(HistoryMessageInjector.getStringProperty(message.getAsJsonObject("raw"), "codexTurnId"))));
        }
    }

    /** Exactly 100 native receipts remain provisional when the appended script output later fails. */
    @Test
    public void pagedFullReceiptBudgetRetainsItsLaterScriptFailure() throws Exception {
        StringBuilder source = new StringBuilder();
        StringBuilder records = new StringBuilder(user("inspect"));
        for (int index = 0; index < 100; index++) {
            source.append("await tools.exec_command({cmd:'task ").append(index).append("'});");
        }
        JsonObject wrapper = JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"full-budget"}}
                """).getAsJsonObject();
        wrapper.getAsJsonObject("payload").addProperty("input", source + "throw new Error('boom');");
        records.append(wrapper).append('\n');
        for (int index = 0; index < 100; index++) {
            JsonObject receipt = JsonParser.parseString("""
                    {"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","status":"completed","exit_code":0}}}
                    """).getAsJsonObject();
            JsonObject item = receipt.getAsJsonObject("payload").getAsJsonObject("item");
            item.addProperty("id", "native-" + index);
            item.addProperty("command", "task " + index);
            item.addProperty("aggregated_output", "passed " + index);
            records.append(receipt).append('\n');
        }
        Files.writeString(this.session, records);
        this.index.read(this.reader, "fixture", null, 30, () -> true);
        Files.writeString(this.session, """
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"full-budget","output":[{"type":"input_text","text":"Script failed\\nWall time 0.1 seconds\\nOutput:\\n"},{"type":"input_text","text":"Script error:\\nboom"}]}}
                """, StandardOpenOption.APPEND);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), JsonArray.class));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        assertTrue(full.toString().contains("\"name\":\"exec\""));
        assertTrue(full.toString().contains("boom"));
    }

    /** Deferred reasoning keeps its recorded turn in previews and after the final wait is appended. */
    @Test
    public void pagedDeferredReasoningKeepsItsTurnAcrossAppend() throws Exception {
        Files.writeString(this.session, user("inspect") + """
                {"type":"session_meta","payload":{"id":"thread"}}
                {"type":"turn_context","payload":{"turn_id":"first-turn"}}
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"yielded","input":"await tools.exec_command({cmd:'npm test'});"}}
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"first-turn","item":{"type":"CommandExecution","id":"native","command":"npm test","status":"completed","exit_code":0,"aggregated_output":"passed"}}}
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"yielded","output":[{"type":"input_text","text":"Script running with cell ID cell-1\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                {"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"first thought"}]}}
                {"type":"turn_context","payload":{"turn_id":"next-turn"}}
                {"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"next thought"}]}}
                """);
        for (boolean completed : java.util.List.of(false, true)) {
            if (completed) {
                Files.writeString(this.session, """
                        {"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":"wait-1","arguments":"{\\"cell_id\\":\\"cell-1\\"}"}}
                        {"type":"response_item","payload":{"type":"function_call_output","call_id":"wait-1","output":[{"type":"input_text","text":"Script completed\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                        """, StandardOpenOption.APPEND);
            }
            var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                    this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
            assertEquals(java.util.List.of("first-turn", "next-turn"), full.stream()
                    .filter(message -> message.toString().contains(" thought"))
                    .map(message -> message.getAsJsonObject("raw").get("codexTurnId").getAsString()).toList());
            assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        }
    }

    /** Partial native batch results remain visible in previews without committing them before append. */
    @Test
    public void pagedPartialBatchKeepsCompletedResultsAcrossAppend() throws Exception {
        Files.writeString(this.session, user("inspect") + """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"partial","input":"const jobs=['npm test','git status'];await Promise.all(jobs.map(cmd=>tools.exec_command({cmd})));"}}
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn","item":{"type":"CommandExecution","id":"first","command":"npm test","status":"completed","exit_code":0,"aggregated_output":"first passed"}}}
                """);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertTrue(full.toString().contains("first passed"));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        Files.writeString(this.session, """
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn","item":{"type":"CommandExecution","id":"second","command":"git status","status":"completed","exit_code":0,"aggregated_output":"second passed"}}}
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"partial","output":[{"type":"input_text","text":"Script completed\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                """ + assistant("done"), StandardOpenOption.APPEND);
        full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertTrue(full.toString().contains("first passed"));
        assertTrue(full.toString().contains("second passed"));
        assertFalse(full.toString().contains("\"name\":\"exec\""));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** A yielded cell exposes the same wrapper, wait, reasoning and output in cached and full reads. */
    @Test
    public void pagedYieldedExecKeepsItsContinuationAcrossAppend() throws Exception {
        String records = """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"yielded","input":"await tools.exec_command({cmd:'npm test'});"}}
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn","item":{"type":"CommandExecution","id":"native","command":"npm test","status":"completed","exit_code":0,"aggregated_output":"passed"}}}
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"yielded","output":[{"type":"input_text","text":"Script running with cell ID cell-1\\nWall time 0.1 seconds\\nOutput:\\n"},{"type":"input_text","text":"progress"}]}}
                {"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"waiting for the cell"}]}}
                {"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":"wait-1","arguments":"{\\"cell_id\\":\\"cell-1\\"}"}}
                """;
        Files.writeString(this.session, user("inspect") + records);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertTrue(full.toString().contains("progress"));
        assertTrue(full.toString().contains("waiting for the cell"));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        Files.writeString(this.session, """
                {"type":"response_item","payload":{"type":"function_call_output","call_id":"wait-1","output":[{"type":"input_text","text":"Script completed\\nWall time 0.1 seconds\\nOutput:\\n"}]}}
                """ + assistant("done"), StandardOpenOption.APPEND);
        full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** Unknown source must not hide completed native calls while the wrapper's output is pending. */
    @Test
    public void pagedUnknownExecRetainsItsNativeReceipts() throws Exception {
        Files.writeString(this.session, user("inspect") + """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"unknown","input":"await tools[load('tool')](load('args'));"}}
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn","item":{"type":"CommandExecution","id":"native","command":"npm test","status":"completed","exit_code":0,"aggregated_output":"passed"}}}
                """);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertTrue(full.toString().contains("passed"));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** Keeps a pending known call visible without committing its preview into the page cache. */
    @Test
    public void pagedKnownCommandMatchesFullHistoryAfterItsTerminalOutputIsAppended() throws Exception {
        Files.writeString(this.session, user("inspect") + com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"known",
                "input":"text(await tools.exec_command({cmd:'npm test'}));"}}
                """) + "\n");
        var pending = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertTrue(pending.messages.toString(), pending.messages.toString().contains("bash"));
        assertFalse(pending.messages.toString().contains("tool_result"));
        assertEquals(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class)), pending.messages);
        Files.writeString(this.session, com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"known",
                "output":[{"type":"input_text","text":"{\\"exit_code\\":0,\\"output\\":\\"passed\\"}"}]}}
                """) + "\n", StandardOpenOption.APPEND);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        assertTrue(full.toString().contains("passed"));
    }
    /** Web extensions complete at EOF and indexed web strings survive appended history pages. */
    @Test
    public void pagedWebReceiptsMatchFullHistoryBeforeAndAfterOuterOutput() throws Exception {
        String call = """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"web",
                "input":"text(await tools.web__run({open:[{ref_id:'https://example.com'}]}));"}}
                """;
        String receipt = """
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"Extension","kind":"web.search","id":"web-item","query":"fixture","results":[]}}}
                """;
        Files.writeString(this.session, user("browse") + com.google.gson.JsonParser.parseString(call) + "\n"
                + com.google.gson.JsonParser.parseString(receipt) + "\n");
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(3, full.size());
        assertTrue(full.toString().contains("tool_result"));
        assertTrue(full.toString().contains("webSearch"));
        assertFalse(full.toString().contains("\"name\":\"exec\""));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        Files.writeString(this.session, com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"web",
                "output":"Script completed\\nOutput:\\ncomplete page body"}}
                """) + "\n" + assistant("done"), StandardOpenOption.APPEND);
        full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        assertTrue(full.toString().contains("complete page body"));
        try (var tiny = new CodexHistoryPageIndex(1, 1, 64)) {
            assertEquals(full, tiny.read(this.reader, "fixture", null, 30, () -> true).messages);
        }
    }

    /** Interleaved activity keeps its arrival position before the wrapper's result in previews and after append. */
    @Test
    public void pagedKnownCommandKeepsInterleavedSubagentActivityAcrossItsOutput() throws Exception {
        String call = """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"known",
                "input":"text(await tools.exec_command({cmd:'npm test'}));"}}
                """;
        String activity = """
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"SubAgentActivity","id":"agent-1","kind":"review"}}}
                """;
        Files.writeString(this.session, user("inspect") + com.google.gson.JsonParser.parseString(call) + "\n"
                + com.google.gson.JsonParser.parseString(activity) + "\n");
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertTrue(full.toString().contains("\"name\":\"exec\""));
        assertTrue(full.toString().contains("subAgentActivity"));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        Files.writeString(this.session, com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"known",
                "output":[{"type":"input_text","text":"{\\"exit_code\\":0,\\"output\\":\\"passed\\"}"}]}}
                """) + "\n" + assistant("done"), StandardOpenOption.APPEND);
        full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        assertTrue(full.toString().contains("passed"));
        assertTrue("the activity arrived before the wrapper's result",
                full.toString().indexOf("subAgentActivity") < full.toString().indexOf("passed"));
    }

    /** Completed native receipts survive EOF and remain identical after append or cache-budget fallback. */
    @Test
    public void pagedNativeReceiptStaysCompletedBeforeTheOuterResultArrives() throws Exception {
        Files.writeString(this.session, user("inspect") + com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"known",
                "input":"text(await tools.exec_command({cmd:'npm test'}));"}}
                """) + "\n" + com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"CommandExecution","id":"native-command","status":"completed","exit_code":0,
                "command":["pwsh.exe","-Command","npm test"],"stdout":"passed"}}}
                """) + "\n");
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(3, full.size());
        assertTrue(full.toString().contains("tool_result"));
        assertFalse(full.toString().contains("\"name\":\"exec\""));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        try (var tiny = new CodexHistoryPageIndex(1, 1, 64)) {
            assertEquals(full, tiny.read(this.reader, "fixture", null, 30, () -> true).messages);
        }
        Files.writeString(this.session,
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"known\",\"output\":\"Script completed\"}}\n"
                        + assistant("done"), StandardOpenOption.APPEND);
        full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(4, full.size());
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** Keeps recorded dynamic patch cards identical in full reads and appended cached pages. */
    @Test
    public void pagedDynamicFileChangesMatchFullHistoryAfterAppend() throws Exception {
        String call = """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"dynamic",
                "input":"await tools.apply_patch(result.output);"}}
                """;
        String event = """
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"FileChange","id":"stored-edit","status":"completed",
                "changes":{"a.ts":{"type":"add","content":"actual content\\n"}},"stdout":"applied","stderr":""}}}
                """;
        Files.writeString(this.session, user("inspect") + com.google.gson.JsonParser.parseString(call) + "\n"
                + com.google.gson.JsonParser.parseString(event) + "\n");
        var initial = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertTrue(initial.messages.toString().contains("file_change"));
        Files.writeString(this.session, """
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"dynamic","output":"Script completed"}}
                """ + assistant("done"), StandardOpenOption.APPEND);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(full, page.messages);
        assertEquals(4, page.messages.size());
        assertEquals(page.messages, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** Uses the same patch and compaction projection for cached pages and full reads. */
    @Test
    public void pagedPatchesAndCompactionBoundariesMatchFullHistory() throws Exception {
        String patch = "*** Begin Patch\n*** Add File: a.ts\n+const a = 1;\n*** End Patch";
        var call = new com.google.gson.JsonObject();
        call.addProperty("type", "response_item");
        var payload = new com.google.gson.JsonObject();
        payload.addProperty("type", "custom_tool_call");
        payload.addProperty("call_id", "patch-wrapper");
        payload.addProperty("name", "exec");
        payload.addProperty("input", "text(await tools.apply_patch(" + new Gson().toJson(patch) + ")); ");
        call.add("payload", payload);
        Files.writeString(this.session, user("inspect") + call + "\n"
                + "{\"type\":\"compacted\",\"timestamp\":\"2026-10-02T10:30:00Z\",\"payload\":{\"message\":\"\"}}\n"
                + assistant("done"));
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(full, page.messages);
        assertEquals(4, page.messages.size());
        assertTrue(page.messages.get(1).toString().contains("apply_patch"));
        assertTrue(page.messages.get(2).getAsJsonObject("raw").get("isCompactSummary").getAsBoolean());
        assertEquals(page.messages, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }
    private Path directory;
    private Path session;
    private CodexHistoryReader reader;
    private final CodexHistoryPageIndex index = new CodexHistoryPageIndex();

    @Before
    public void setup() throws Exception {
        directory = Files.createTempDirectory("codex-page-index-test");
        session = directory.resolve("rollout-fixture.jsonl");
        var constructor = CodexHistoryReader.class.getDeclaredConstructor(Path.class, Gson.class);
        constructor.setAccessible(true);
        reader = constructor.newInstance(directory, new Gson());
    }

    @After
    public void cleanup() throws Exception {
        index.close();
        try (var paths = Files.walk(directory)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    @Test
    public void ignoresNullPayloadTypeWithoutLosingAdjacentMessages() throws Exception {
        assertMalformedRecordIsSkipped("{\"type\":\"response_item\",\"payload\":{\"type\":null}}");
    }

    @Test
    public void ignoresObjectPayloadTypeWithoutLosingAdjacentMessages() throws Exception {
        assertMalformedRecordIsSkipped("{\"type\":\"response_item\",\"payload\":{\"type\":{}}}");
    }

    @Test
    public void ignoresNullFunctionNameWithoutLosingAdjacentMessages() throws Exception {
        assertMalformedRecordIsSkipped("{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":null}}");
    }

    private void assertMalformedRecordIsSkipped(String malformed) throws Exception {
        Files.writeString(session, user("question") + malformed + "\n" + assistant("answer"));
        var expected = HistoryMessageInjector.scanCodexHistoryPage(reader, "fixture", null, 30);
        assertEquals(2, expected.messages.size());
        var actual = index.read(reader, "fixture", null, 30, () -> true);
        assertEquals(expected.messages, actual.messages);
        assertEquals(2, actual.rawRecordCount);
        assertEquals(1, actual.totalTurns);
        var repeated = index.read(reader, "fixture", null, 30, () -> true);
        assertEquals(expected.messages, repeated.messages);
        assertEquals(0, repeated.rawRecordCount);
    }

    @Test
    public void consumerCancellationIsNotSwallowedAsMalformedInput() throws Exception {
        Files.writeString(session, user("question") + assistant("answer"));
        CancellationException cancelled = new CancellationException("consumer cancelled");
        var thrown = assertThrows(CancellationException.class,
                () -> reader.forEachSessionMessage(session, 0, Files.size(session), () -> true, message -> {
                    throw cancelled;
                }));
        assertSame(cancelled, thrown);
    }

    @Test
    public void consecutivePagesDoNotParseStableHistoryAgain() throws Exception {
        StringBuilder history = new StringBuilder();
        for (int turn = 0; turn < 1000; turn++) {
            history.append(user("question-" + turn)).append(assistant("answer-" + turn));
        }
        Files.writeString(session, history);
        var latest = index.read(reader, "fixture", null, 30, () -> true);
        var previous = index.read(reader, "fixture", 970, 30, () -> true);
        var earlier = index.read(reader, "fixture", 940, 30, () -> true);
        assertEquals(1000, latest.totalTurns);
        assertEquals(60, previous.messages.size());
        assertEquals(940, previous.fromTurn);
        assertEquals(2000, latest.rawRecordCount);
        assertEquals(Files.size(session), latest.sourceBytesRead);
        assertEquals(0, previous.sourceBytesRead + earlier.sourceBytesRead);
        assertEquals("Stable pages must not parse the complete JSONL again", 0,
                previous.rawRecordCount + earlier.rawRecordCount);
    }

    /** Appends crossing byte and UTF-8 boundaries keep valid partial-block fingerprints without reparsing the prefix. */
    @Test
    public void partialFingerprintBlocksSurviveRepeatedUtf8Appends() throws Exception {
        Files.writeString(this.session, user("H".repeat(4100)) + assistant("first"));
        assertEquals(1, this.index.read(this.reader, "fixture", null, 30, () -> true).totalTurns);
        for (int round = 0; round < 3; round++) {
            String appended = user("中文😀".repeat(1700) + round) + assistant("answer-" + round);
            Files.writeString(this.session, appended, StandardOpenOption.APPEND);
            var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
            assertEquals(round + 2, page.totalTurns);
            assertEquals(2, page.rawRecordCount);
            assertEquals(appended.getBytes(java.nio.charset.StandardCharsets.UTF_8).length, page.sourceBytesRead);
            var stable = this.index.read(this.reader, "fixture", null, 30, () -> true);
            assertEquals(page.messages, stable.messages);
            assertEquals(0, stable.rawRecordCount);
            assertEquals(0, stable.sourceBytesRead);
        }
    }

    @Test
    public void retainsToolIdsAcrossPagesAndAppendedOutput() throws Exception {
        String call = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\","
                + "\"name\":\"exec_command\",\"call_id\":\"cross-turn\",\"arguments\":\"{\\\"cmd\\\":\\\"echo ok\\\"}\"}}\n";
        String output = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\","
                + "\"call_id\":\"cross-turn\",\"output\":\"ok\"}}\n";
        Files.writeString(session, user("first") + call + user("second"));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, output, StandardOpenOption.APPEND);
        var latest = index.read(reader, "fixture", null, 1, () -> true);
        var previous = index.read(reader, "fixture", 1, 1, () -> true);
        var tool = previous.messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        var result = latest.messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals(tool.get("id"), result.get("tool_use_id"));
        assertEquals("ok", result.get("content").getAsString());
        assertEquals(2, latest.totalTurns);
        assertEquals(1, latest.rawRecordCount);
        assertEquals(0, previous.rawRecordCount);
    }

    @Test
    public void appendUpdatesUsageOnAnAlreadyPersistedAssistant() throws Exception {
        Files.writeString(session, user("first") + assistant("answer") + user("second"));
        index.read(reader, "fixture", null, 2, () -> true);
        Files.writeString(session, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"last_token_usage\":{\"input_tokens\":12,\"output_tokens\":3},\"model_context_window\":200000}}}\n",
                StandardOpenOption.APPEND);
        var previous = index.read(reader, "fixture", 1, 1, () -> true);
        assertEquals(12, previous.messages.get(1).getAsJsonObject("raw").getAsJsonObject("usage").get("input_tokens").getAsInt());
        previous.messages.get(1).addProperty("content", "mutated by caller");
        assertEquals("answer", index.read(reader, "fixture", 1, 1, () -> true).messages.get(1).get("content").getAsString());
    }

    @Test
    public void replacementWithPreservedSizeAndMtimeRebuildsIndex() throws Exception {
        Files.writeString(session, user("old"));
        index.read(reader, "fixture", null, 1, () -> true);
        var modified = Files.getLastModifiedTime(session);
        Path replacement = directory.resolve("replacement.tmp");
        Files.writeString(replacement, user("new"));
        Files.setLastModifiedTime(replacement, modified);
        Files.move(replacement, session, StandardCopyOption.REPLACE_EXISTING);
        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", page.messages.get(0).get("content").getAsString());
        assertEquals(1, page.rawRecordCount);
    }

    /** Rotating validation must eventually visit a rewrite outside both fixed samples. */
    @Test
    public void equalMetadataMiddleRewriteCannotStayCachedForever() throws Exception {
        String before = user("H".repeat(9000)) + user("OLD") + assistant("T".repeat(9000));
        Files.writeString(this.session, before);
        this.index.read(this.reader, "fixture", null, 30, () -> true);
        Files.writeString(this.session, before.replace("OLD", "NEW"));
        // Force a metadata collision on every OS, including Unix filesystems exposing nanosecond ctime.
        var entriesField = CodexHistoryPageIndex.class.getDeclaredField("entries");
        entriesField.setAccessible(true);
        var entries = (java.util.Map<?, ?>) entriesField.get(this.index);
        // Production keys entries by the session file's real path (/var is a
        // symlink to /private/var on macOS).
        Object entry = entries.get(this.session.toRealPath());
        var snapshotField = entry.getClass().getDeclaredField("snapshot");
        snapshotField.setAccessible(true);
        var readSnapshot = snapshotField.getType().getDeclaredMethod("read", Path.class);
        readSnapshot.setAccessible(true);
        snapshotField.set(entry, readSnapshot.invoke(null, this.session));
        HistoryMessageInjector.CodexHistoryPage page = null;
        for (int attempt = 0; attempt < (Files.size(this.session) + 4095) / 4096; attempt++) {
            page = this.index.read(this.reader, "fixture", null, 30, () -> true);
            if ("NEW".equals(page.messages.get(1).get("content").getAsString())) break;
        }
        assertNotNull(page);
        assertEquals("NEW", page.messages.get(1).get("content").getAsString());
    }

    @Test
    public void sameSizeTailRewriteWithRestoredMtimeRebuildsIndex() throws Exception {
        String prefix = user("prefix".repeat(2000));
        Files.writeString(session, prefix + user("old"));
        index.read(reader, "fixture", null, 1, () -> true);
        var modified = Files.getLastModifiedTime(session);
        Files.writeString(session, prefix + user("new"));
        Files.setLastModifiedTime(session, modified);

        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", page.messages.get(0).get("content").getAsString());
        assertEquals(2, page.rawRecordCount);
        var repeated = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", repeated.messages.get(0).get("content").getAsString());
        assertEquals(0, repeated.rawRecordCount);
    }

    @Test
    public void incompleteTrailingJsonIsReplayedWhenCompleted() throws Exception {
        String second = assistant("中文😀");
        Files.writeString(session, user("first") + second.substring(0, second.length() - 6));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, second.substring(second.length() - 6), StandardOpenOption.APPEND);
        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals(1, page.totalTurns);
        assertEquals(2, page.messages.size());
        assertEquals("中文😀", page.messages.get(1).get("content").getAsString());
    }

    @Test
    public void adjacentUserPairAcrossAppendDoesNotCreateAnotherTurn() throws Exception {
        Files.writeString(session, user("same"));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\","
                + "\"content\":[{\"type\":\"input_text\",\"text\":\"same\"}]}}\n" + assistant("reply"), StandardOpenOption.APPEND);
        var page = index.read(reader, "fixture", null, 5, () -> true);
        assertEquals(1, page.totalTurns);
        assertEquals(2, page.messages.size());
        assertEquals(2, page.rawRecordCount);
    }

    @Test
    public void emptyAndInvalidCursorsPreservePaginationSemantics() throws Exception {
        Files.writeString(session, user("first") + assistant("answer"));
        var empty = index.read(reader, "fixture", 0, 30, () -> true);
        assertTrue(empty.messages.isEmpty());
        assertFalse(empty.cursorReset);
        var reset = index.read(reader, "fixture", 999, 30, () -> true);
        assertTrue(reset.cursorReset);
        assertEquals(0, reset.fromTurn);
        assertEquals(1, reset.toTurn);
        assertThrows(IllegalArgumentException.class, () -> index.read(reader, "fixture", -1, 30, () -> true));
        assertThrows(IllegalArgumentException.class, () -> index.read(reader, "fixture", 1, 0, () -> true));
    }

    @Test
    public void cancellationStopsScanAndDiscardsPartialIndex() throws Exception {
        Files.writeString(session, (user("question") + assistant("answer")).repeat(1000));
        AtomicInteger checks = new AtomicInteger();
        var spools = new java.util.ArrayList<Path>();
        assertThrows(CancellationException.class, () -> index.read(reader, "fixture", null, 30, () -> {
            spools.addAll(index.spoolFiles());
            return checks.incrementAndGet() < 30;
        }));
        assertEquals(30, checks.get());
        assertEquals(0, index.size());
        assertFalse(spools.isEmpty());
        assertTrue(spools.stream().noneMatch(Files::exists));
        var complete = index.read(reader, "fixture", null, 30, () -> true);
        assertEquals(1000, complete.totalTurns);
    }

    /** Cancellation must interrupt fingerprint work before the entire source has been hashed. */
    @Test
    public void cancellationInterruptsSourceFingerprinting() throws Exception {
        Files.writeString(this.session, user("H".repeat(30_000)) + assistant("answer"));
        AtomicInteger observedBlocks = new AtomicInteger();
        var spools = new java.util.ArrayList<Path>();
        assertThrows(CancellationException.class, () -> this.index.read(this.reader, "fixture", null, 30, () -> {
            spools.addAll(this.index.spoolFiles());
            int blocks = this.indexedListSize("blockHashes");
            observedBlocks.accumulateAndGet(blocks, Math::max);
            return blocks < 2;
        }));
        assertEquals("Cancellation must not wait for the remaining fingerprint blocks", 2, observedBlocks.get());
        assertEquals(0, this.index.size());
        assertFalse(spools.isEmpty());
        assertTrue(spools.stream().noneMatch(Files::exists));
        assertEquals("answer", this.index.read(this.reader, "fixture", null, 30, () -> true)
                .messages.get(1).get("content").getAsString());
    }

    /** A stale request cancelled while paging must not evict the fully indexed entry. */
    @Test
    public void cancellationDuringPagingKeepsTheIndexedEntry() throws Exception {
        Files.writeString(this.session, user("question") + assistant("answer"));
        var indexed = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(2, indexed.messages.size());
        assertEquals(1, this.index.size());
        var spools = this.index.spoolFiles();
        assertEquals(1, spools.size());
        AtomicInteger checks = new AtomicInteger();
        assertThrows(CancellationException.class, () -> this.index.read(this.reader, "fixture", null, 30,
                () -> checks.incrementAndGet() < 2));
        assertEquals("a fully indexed entry survives another request's cancellation", 1, this.index.size());
        assertTrue(spools.stream().allMatch(Files::exists));
        var cached = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(indexed.messages, cached.messages);
        assertEquals("the follow-up read is served from the retained cache", 0, cached.rawRecordCount);
    }

    /** Fingerprints must describe the parsed bytes rather than a rewrite observed after parsing. */
    @Test
    public void rewriteAfterParsingCannotBecomeTheOldPagesFingerprint() throws Exception {
        String before = user("question") + assistant("old answer") + user("follow-up");
        String after = before.replace("old answer", "new answer");
        Files.writeString(this.session, before);
        var modified = Files.getLastModifiedTime(this.session);
        var rewritten = new java.util.concurrent.atomic.AtomicBoolean();
        try {
            this.index.read(this.reader, "fixture", null, 30, () -> {
                if (this.indexedListSize("offsets") == 2 && rewritten.compareAndSet(false, true)) {
                    try {
                        Files.writeString(this.session, after);
                        Files.setLastModifiedTime(this.session, modified);
                    } catch (java.io.IOException exception) {
                        throw new java.io.UncheckedIOException(exception);
                    }
                }
                return true;
            });
        } catch (java.io.IOException exception) {
            // Unix ctime can reject the rewrite immediately; Windows must detect it from the parsed baseline.
            assertTrue(exception.getMessage(), exception.getMessage().contains("changed"));
        }
        assertTrue("The rewrite must happen after both original messages are parsed", rewritten.get());
        var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals("new answer", page.messages.get(1).get("content").getAsString());
        assertEquals(page.messages, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** Large ignored records must not bypass the memory budget for retained source fingerprints. */
    @Test
    public void fingerprintBudgetFallsBackWithoutDroppingHistory() throws Exception {
        String metadata = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"fixture\",\"padding\":\""
                + "x".repeat(4096) + "\"}}\n";
        Files.writeString(this.session, user("question") + assistant("answer") + metadata.repeat(100));
        try (var bounded = new CodexHistoryPageIndex(1, 10, 12 * 1024)) {
            var spools = new java.util.ArrayList<Path>();
            var page = bounded.read(this.reader, "fixture", null, 30, () -> {
                spools.addAll(bounded.spoolFiles());
                return true;
            });
            assertEquals(1, page.totalTurns);
            assertEquals(2, page.messages.size());
            assertEquals("answer", page.messages.get(1).get("content").getAsString());
            assertEquals("fixture", page.threadId);
            assertEquals("Source fingerprints must share the bounded-cache policy", 0, bounded.size());
            assertTrue(spools.stream().noneMatch(Files::exists));
        }
    }

    private int indexedListSize(String fieldName) {
        try {
            var entriesField = CodexHistoryPageIndex.class.getDeclaredField("entries");
            entriesField.setAccessible(true);
            var entries = (java.util.Map<?, ?>) entriesField.get(this.index);
            // Production keys entries by the session file's real path; on macOS
            // the temp dir's /var is a symlink to /private/var.
            Object entry = entries.get(this.session.toRealPath());
            if (entry == null) {
                return 0;
            }
            var field = entry.getClass().getDeclaredField(fieldName);
            field.setAccessible(true);
            return ((java.util.List<?>) field.get(entry)).size();
        } catch (ReflectiveOperationException | java.io.IOException exception) {
            throw new AssertionError(exception);
        }
    }

    @Test
    public void lruEvictsSpoolsAndCloseDeletesRemainingFiles() throws Exception {
        Files.writeString(session, user("first"));
        index.read(reader, "fixture", null, 1, () -> true);
        Path firstSpool = index.spoolFiles().get(0);
        for (int number = 0; number < 3; number++) {
            String id = "other-" + number;
            Files.writeString(directory.resolve(id + ".jsonl"), user(id));
            index.read(reader, id, null, 1, () -> true);
        }
        assertEquals(2, index.size());
        assertFalse(Files.exists(firstSpool));
        var remaining = index.spoolFiles();
        index.close();
        assertEquals(0, index.size());
        assertTrue(remaining.stream().noneMatch(Files::exists));
    }

    @Test
    public void oversizedPendingMessageIsNotRetained() throws Exception {
        Files.writeString(session, user("large".repeat(1000)));
        try (var bounded = new CodexHistoryPageIndex(1, 10, 1000)) {
            var page = bounded.read(reader, "fixture", null, 1, () -> true);
            assertEquals(1, page.totalTurns);
            assertEquals(0, bounded.size());
        }
    }

    @Test
    public void messageAndDiskBudgetsFallBackWithoutDroppingHistory() throws Exception {
        Files.writeString(session, (user("question") + assistant("answer")).repeat(10));
        try (var bounded = new CodexHistoryPageIndex(1, 2, 4096)) {
            var page = bounded.read(reader, "fixture", 4, 2, () -> true);
            assertEquals(10, page.totalTurns);
            assertEquals(4, page.messages.size());
            assertEquals(0, bounded.size());
        }
        try (var bounded = new CodexHistoryPageIndex(1, 100, 32)) {
            var page = bounded.read(reader, "fixture", 4, 2, () -> true);
            assertEquals(10, page.totalTurns);
            assertEquals(4, page.messages.size());
            assertEquals(0, bounded.size());
        }
    }

    @Test
    public void indexedPagesMatchStreamingConversionIncludingMetadataAndMalformedLines() throws Exception {
        StringBuilder history = new StringBuilder("{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-fixture\",\"cwd\":\"/synthetic\"}}\n");
        for (int turn = 0; turn < 12; turn++) {
            history.append(user("question-" + turn).stripTrailing()).append(assistant("answer-" + turn));
            history.append("{invalid json\n\n");
        }
        Files.writeString(session, history);
        Integer[] cursors = {null, 0, 1, 5, 12, 100};
        for (Integer cursor : cursors) {
            var expected = HistoryMessageInjector.scanCodexHistoryPage(reader, "fixture", cursor, 3);
            var actual = index.read(reader, "fixture", cursor, 3, () -> true);
            assertEquals(expected.messages, actual.messages);
            assertEquals(expected.fromTurn, actual.fromTurn);
            assertEquals(expected.toTurn, actual.toTurn);
            assertEquals(expected.totalTurns, actual.totalTurns);
            assertEquals(expected.cursorReset, actual.cursorReset);
            assertEquals("thread-fixture", actual.threadId);
            assertEquals("/synthetic", actual.cwd);
        }
    }

    /** Equal-size overwrites must invalidate the cache on systems without a reliable change timestamp. */
    @Test
    public void sameInodeRewriteWithPreservedMtimeRebuildsIndex() throws Exception {
        Files.writeString(session, user("old"));
        index.read(reader, "fixture", null, 1, () -> true);
        var modified = Files.getLastModifiedTime(session);
        Files.writeString(session, user("new"));
        Files.setLastModifiedTime(session, modified);
        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", page.messages.get(0).get("content").getAsString());
        assertEquals(1, page.rawRecordCount);
    }

    @Test
    public void replacementDuringScanDoesNotPublishMixedContents() throws Exception {
        Files.writeString(session, (user("question") + assistant("answer")).repeat(100));
        AtomicInteger checks = new AtomicInteger();
        assertThrows(java.io.IOException.class, () -> index.read(reader, "fixture", null, 30, () -> {
            if (checks.incrementAndGet() == 10) {
                try {
                    Files.writeString(session, user("replacement"));
                } catch (java.io.IOException exception) {
                    throw new java.io.UncheckedIOException(exception);
                }
            }
            return true;
        }));
        assertEquals(0, index.size());
        assertEquals("replacement", index.read(reader, "fixture", null, 1, () -> true).messages.get(0).get("content").getAsString());
    }

    @Test
    public void appendParsesOnlyNewRecordsAndTruncationResetsCursor() throws Exception {
        Files.writeString(session, user("first") + assistant("answer"));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, user("second") + assistant("next"), StandardOpenOption.APPEND);
        var appended = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals(2, appended.totalTurns);
        assertEquals(2, appended.rawRecordCount);
        Files.writeString(session, user("replacement"));
        var truncated = index.read(reader, "fixture", 2, 1, () -> true);
        assertTrue(truncated.cursorReset);
        assertEquals(1, truncated.totalTurns);
        assertEquals("replacement", truncated.messages.get(0).get("content").getAsString());
    }

    static String user(String text) {
        return "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"" + text + "\"}}\n";
    }

    /** Verifies the disk-backed page path keeps the same tools and thinking as full history. */
    @Test
    public void pagedHistoryRestoresExecCommandsReasoningAndHidesPageMetadata() throws Exception {
        String source = user("<external_codex_apps_open_page>{}</external_codex_apps_open_page>")
                + user("inspect")
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"id\":\"r1\","
                + "\"summary\":[{\"type\":\"summary_text\",\"text\":\"Check the transport\"}],\"encrypted_content\":\"opaque\"}}\n"
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec\","
                + "\"call_id\":\"c1\",\"input\":\"text(await tools.exec_command({cmd:'git status',workdir:'D:/demo'}));\"}}\n"
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\","
                + "\"call_id\":\"c1\",\"output\":\"On branch main\"}}\n" + assistant("done");
        Files.writeString(this.session, source);
        var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(1, page.totalTurns);
        assertEquals(5, page.messages.size());
        var thinking = page.messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("thinking", thinking.get("type").getAsString());
        assertEquals("Check the transport", thinking.get("thinking").getAsString());
        var tool = page.messages.get(2).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("git status", tool.getAsJsonObject("input").get("command").getAsString());
        assertTrue(page.messages.get(3).toString().contains("On branch main"));
        assertFalse(page.messages.toString().contains("open_page"));
        assertFalse(page.messages.toString().contains("opaque"));
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, page.messages);
    }

    /** Retains unreadable reasoning as a status boundary without exposing ciphertext or invented text. */
    @Test
    public void encryptedOnlyReasoningDoesNotBecomeTranscriptText() throws Exception {
        Files.writeString(this.session, user("inspect")
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"encrypted_content\":\"cipher\"}}\n"
                + assistant("done"));
        var messages = this.index.read(this.reader, "fixture", null, 30, () -> true).messages;
        assertEquals(3, messages.size());
        var thinking = messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("thinking", thinking.get("type").getAsString());
        assertEquals("", thinking.get("thinking").getAsString());
        assertTrue(thinking.get("native").getAsBoolean());
        assertEquals("completed", thinking.get("status").getAsString());
        assertFalse(messages.toString().contains("cipher"));
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, messages);
    }

    static String assistant(String text) {
        return "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\","
                + "\"content\":[{\"type\":\"output_text\",\"text\":\"" + text + "\"}]}}\n";
    }
}
