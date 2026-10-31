package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Exercises orchestration and lifecycle shapes from the Codex Code Mode source contracts. */
public class CodexExecSourceReplayTest {
    private static final String COMPLETED = "Script completed\nWall time 0.1 seconds\nOutput:\n";
    private static final String YIELDED = "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n";

    /** An early buffer release must retain edits after the first yield or notification. */
    @Test
    public void keepsLateEditsWhenTheReplayBudgetRunsOutBeforeYield() {
        for (boolean notifications : List.of(false, true)) {
            JsonArray records = scope("turn");
            records.add(call("exec", (notifications ? "notify('progress');" : "") + "await tools[load('tool')](load('args'));"));
            for (int index = 0; index < 101; index++) {
                records.add(command("native-" + index, "task " + index, 0));
            }
            records.add(output("exec", notifications ? "progress" : YIELDED));
            if (!notifications) {
                records.add(waitCall("wait-1", "cell-1"));
            }
            records.add(patch("late-edit", "saved.txt", "retained\n", "completed"));
            records.add(output(notifications ? "exec" : "wait-1", COMPLETED));
            List<JsonObject> blocks = blocks(records);
            assertEquals("notifications=" + notifications, 1, blocks.stream().filter(block -> "late-edit".equals(text(block, "id"))).count());
            assertEquals(1, blocks.stream().filter(block -> "late-edit".equals(text(block, "tool_use_id"))).count());
        }
    }

    /** Wait requests and replies keep their arrival turns when an opaque cell spans turns. */
    @Test
    public void keepsWaitRecordsInTheirArrivalTurns() {
        for (String waitingTurn : List.of("\"waiting-turn\"", "null")) {
            JsonArray records = scope("turn");
            records.add(call("exec", "await tools[load('tool')](load('args'));"));
            records.add(output("exec", YIELDED));
            records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":" + waitingTurn + "}}"));
            records.add(waitCall("wait-1", "cell-1"));
            records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"reply-turn\"}}"));
            records.add(output("wait-1", COMPLETED));
            List<JsonObject> waits = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).stream()
                    .filter(message -> message.toString().contains("wait-1")).toList();
            assertEquals(2, waits.size());
            assertEquals(java.util.Arrays.asList("null".equals(waitingTurn) ? null : "waiting-turn", "reply-turn"), waits.stream()
                    .map(message -> text(message.getAsJsonObject("raw"), "codexTurnId")).toList());
        }
    }

    /** Repeated EOF previews retain the lifecycle needed to close an image started before exec. */
    @Test
    public void keepsRunningImageStateInContinuationPreviews() {
        JsonArray records = scope("turn");
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"turn",
                "item":{"type":"ImageGeneration","id":"image","status":"in_progress","result":""}}}
                """));
        records.add(call("exec", "await tools[load('tool')](load('args'));"));
        records.add(output("exec", YIELDED));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn","reason":"interrupted"}}
                """));
        List<JsonObject> committed = new ArrayList<>();
        var accumulator = new HistoryMessageInjector.CodexFrontendMessageAccumulator(committed::add, ignored -> { });
        records.forEach(record -> accumulator.accept(record.getAsJsonObject()));
        for (int attempt = 0; attempt < 2; attempt++) {
            List<JsonObject> preview = new ArrayList<>(committed);
            preview.addAll(accumulator.pendingMessages());
            assertEquals(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records), preview);
            assertTrue(preview.stream().anyMatch(message -> message.toString().contains("\"tool_use_id\":\"image\"")
                    && message.toString().contains("\"is_error\":true")));
        }
        JsonObject terminal = output("exec", "Script terminated\nWall time 0.1 seconds\nOutput:\n");
        records.add(terminal);
        accumulator.accept(terminal);
        List<JsonObject> completed = new ArrayList<>(committed);
        completed.addAll(accumulator.pendingMessages());
        assertEquals(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records), completed);
    }

    /** A late result keeps the same legacy owner in an EOF preview and a committed flush. */
    @Test
    public void keepsPreviousToolOwnersInContinuationPreviews() {
        for (String source : List.of("text(await tools.exec_command({cmd:'npm test'}));", "text(await tools.update_plan({plan:[]}));")) {
            JsonArray records = new JsonArray();
            records.add(call("previous", source));
            records.add(call("exec", "await tools[load('tool')](load('args'));"));
            records.add(output("previous", COMPLETED, "{\"exit_code\":0,\"output\":\"passed\"}"));
            List<JsonObject> committed = new ArrayList<>();
            var accumulator = new HistoryMessageInjector.CodexFrontendMessageAccumulator(committed::add, ignored -> { });
            records.forEach(record -> accumulator.accept(record.getAsJsonObject()));
            List<JsonObject> preview = new ArrayList<>(committed);
            preview.addAll(accumulator.pendingMessages());
            assertEquals(source, HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records), preview);
            List<JsonObject> previous = preview.stream().filter(message -> message.toString().contains("previous"))
                    .flatMap(message -> message.getAsJsonObject("raw").getAsJsonArray("content").asList().stream())
                    .map(JsonElement::getAsJsonObject).toList();
            List<JsonObject> tools = previous.stream().filter(block -> "tool_use".equals(text(block, "type"))).toList();
            List<JsonObject> results = previous.stream().filter(block -> "tool_result".equals(text(block, "type"))).toList();
            assertEquals(1, tools.size());
            assertEquals(1, results.size());
            assertEquals(text(tools.get(0), "id"), text(results.get(0), "tool_use_id"));
            assertTrue(source, text(results.get(0), "content").contains(source.contains("update_plan") ? "Plan updated" : "passed"));
        }
    }

    /** Tool inventories cannot erase a native tool absent from the inventory. */
    @Test
    public void retainsUnlistedNativeWebReceiptsBesideInventories() {
        for (boolean extraWeb : List.of(true, false)) {
            JsonArray records = scope("turn");
            records.add(call("exec", "await tools[load('tool')](load('args'));"));
            JsonObject web = JsonParser.parseString("""
                    {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                    "item":{"type":"WebSearch","id":"web","status":"completed","query":"fixture","output":"web body"}}}
                    """).getAsJsonObject();
            records.add(web);
            if (extraWeb) {
                records.add(command("native", "npm test", 0));
            }
            JsonObject terminal = output("exec", COMPLETED);
            inventory(terminal, "exec", true, extraWeb
                    ? "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}}]"
                    : "[{\"name\":\"web__run\",\"arguments\":{\"search_query\":[{\"q\":\"fixture\"}]}}]");
            records.add(terminal);
            List<JsonObject> blocks = blocks(records);
            assertTrue(results(blocks).contains("web body"));
            assertEquals(extraWeb, names(blocks).contains("exec"));
        }
    }

    /** Buffering an abort cannot lend it the identity of an already completed turn. */
    @Test
    public void keepsUnscopedAbortsFromClosingCompletedTurns() {
        JsonArray records = scope("turn");
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}
                """));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"turn",
                "item":{"type":"ImageGeneration","id":"image","status":"in_progress","result":""}}}
                """));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}}
                """));
        records.add(call("exec", "await tools[load('tool')](load('args'));"));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":null,"reason":"interrupted"}}
                """));
        assertFalse(blocks(records).stream().anyMatch(block -> "image".equals(text(block, "tool_use_id"))));
    }

    /** A task started during exec still owns a later abort that omits its turn identity. */
    @Test
    public void keepsDeferredTaskStartsForUnscopedAborts() {
        JsonArray records = scope("earlier");
        records.add(call("exec", "await tools[load('tool')](load('args'));"));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"task_started","turn_id":"next"}}
                """));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"next",
                "item":{"type":"ImageGeneration","id":"image","status":"in_progress","result":""}}}
                """));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":null,"reason":"interrupted"}}
                """));
        List<JsonObject> blocks = blocks(records);
        assertTrue(blocks.stream().anyMatch(block -> "image".equals(text(block, "tool_use_id")) && block.get("is_error").getAsBoolean()));
    }

    /** Foreign receipts remain visible even when a different wrapper owns the replay window. */
    @Test
    public void retainsReceiptsOutsideTheWrapperScope() {
        for (String source : List.of("await tools[load('tool')](load('args'));", "text(await tools.exec_command({cmd:'git status'}));")) {
            for (String mismatch : List.of("turn_id", "thread_id")) {
                JsonArray records = scope("turn");
                records.add(call("exec", source));
                JsonObject background = command("background", "npm run dev", 0);
                background.getAsJsonObject("payload").addProperty(mismatch, "earlier");
                records.add(background);
                records.add(output("exec", COMPLETED, "{\"exit_code\":0,\"output\":\"status\"}"));
                List<JsonObject> blocks = blocks(records);
                assertEquals(source + mismatch, 1, blocks.stream().filter(block -> "background".equals(text(block, "id"))).count());
                assertEquals(1, results(blocks).stream().filter(result -> result.equals("background output")).count());
            }
        }
    }

    /** A later turn's receipts survive both unfinished and completed continuation fallbacks. */
    @Test
    public void keepsCrossTurnContinuationReceiptsInFallback() {
        for (boolean completed : List.of(false, true)) {
            JsonArray records = scope("turn");
            records.add(call("exec", "await tools.exec_command({cmd:'npm test'});await tools.exec_command({cmd:'npm run build'});"));
            records.add(command("first", "npm test", 0));
            records.add(output("exec", YIELDED));
            records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"next-turn\"}}"));
            JsonObject second = command("second", "npm run build", 0);
            second.getAsJsonObject("payload").addProperty("turn_id", "next-turn");
            records.add(second);
            if (completed) {
                records.add(waitCall("wait-1", "cell-1"));
                records.add(output("wait-1", COMPLETED));
            }
            List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            assertTrue(names(blocks(records)).contains("exec"));
            assertTrue(results(blocks(records)).contains("second output"));
            assertTrue(messages.stream().anyMatch(message -> message.toString().contains("second output")
                    && "next-turn".equals(text(message.getAsJsonObject("raw"), "codexTurnId"))));
        }
    }

    /** Independent batches cannot share numeric slots without their own native outcomes. */
    @Test
    public void refusesIndexReuseAcrossIndependentGroups() {
        String source = "const jobs=[{cmd:'npm test'},{cmd:'git status'}];"
                + "const first=await Promise.all([tools.exec_command({cmd:'ls'}),tools.exec_command({cmd:'pwd'})]);"
                + "first.forEach((result,i)=>text(JSON.stringify({i,result})));"
                + "for(const r of await Promise.all(jobs.map(j=>tools.exec_command(j))))text(r);";
        for (boolean nativeReceipts : List.of(false, true)) {
            JsonArray records = scope("turn");
            records.add(call("exec", source));
            if (nativeReceipts) {
                records.add(command("tests", "npm test", 1));
                records.add(command("status", "git status", 0));
                records.add(command("pwd", "pwd", 0));
                records.add(command("ls", "ls", 0));
            }
            records.add(output("exec", COMPLETED,
                    "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"ls out\"}}",
                    "{\"i\":1,\"result\":{\"exit_code\":0,\"output\":\"pwd out\"}}",
                    "{\"exit_code\":1,\"output\":\"tests failed\"}", "{\"exit_code\":0,\"output\":\"status out\"}"));
            List<JsonObject> blocks = blocks(records);
            if (nativeReceipts) {
                assertEquals(List.of("bash", "bash", "bash", "bash"), names(blocks));
                assertEquals(List.of("ls output", "pwd output", "tests output", "status output"), results(blocks));
            } else {
                assertEquals(List.of("exec"), names(blocks));
                assertTrue(results(blocks).get(0).contains("tests failed"));
            }
        }
    }

    /** Rejecting multiple groups must not let the legacy array reader retry their ambiguous outputs. */
    @Test
    public void keepsIndependentLiteralGroupsOutOfLegacyReplay() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "const first=await Promise.all([tools.exec_command({cmd:'ls'}),tools.exec_command({cmd:'pwd'})]);"
                + "first.forEach((result,i)=>text({i,result}));"
                + "const second=await Promise.all([tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'git status'})]);second.forEach(text);"));
        records.add(output("exec", COMPLETED, "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"ls out\"}}",
                "{\"i\":1,\"result\":{\"exit_code\":0,\"output\":\"pwd out\"}}",
                "{\"exit_code\":1,\"output\":\"tests failed\"}", "{\"exit_code\":0,\"output\":\"status out\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("exec"), names(blocks));
        assertTrue(results(blocks).get(0).contains("tests failed"));
    }

    /** Mutations, shadowed jobs and hidden alias calls cannot borrow a literal command's result. */
    @Test
    public void keepsUnprovenBindingsAndLoopBodiesOpaque() {
        for (String source : List.of(
                "const jobs=[{cmd:'npm test'},{cmd:'git status'}];for(const job of jobs)text(await tools.exec_command(job)),jobs[1]={cmd:'rm -rf dist'};",
                "let jobs=[{cmd:'git status'}];if(globalThis.dry){const jobs=[{cmd:'npm test'}];}for(const job of jobs)text(await tools.exec_command(job));",
                "async function cleanup(){return run({cmd:'rm -rf dist'});}const run=tools.exec_command;await run({cmd:'npm test'});text(await cleanup());",
                "const run=tools.exec_command;async function cleanup(){return run({cmd:'rm -rf dist'});}text(await run({cmd:'npm test'}));text(await cleanup());",
                "const run=tools.exec_command;const cleanup=async()=>run({cmd:'rm -rf dist'});text(await run({cmd:'npm test'}));text(await cleanup());",
                "const {exec_command:run}=tools;const cleanup=async()=>run({cmd:'rm -rf dist'});text(await run({cmd:'npm test'}));text(await cleanup());",
                "const cleanup=async()=>tools.exec_command({cmd:'rm -rf dist'});text(await tools.exec_command({cmd:'npm test'}));text(await cleanup());",
                "const jobs=[{cmd:'npm test'}];const later=async()=>await Promise.all(jobs.map(job=>tools.exec_command(job)));",
                "const args={cmd:'npm test'};mutate();text(await tools.exec_command(args));function mutate(){args.cmd='rm -rf build';}",
                "function mutate(){args.cmd='rm -rf build';}const args={cmd:'npm test'};mutate();text(await tools.exec_command(args));",
                "const args={cmd:'npm test'};mutate(\"tools.exec_command({label:'\",args,\"'})\");text(await tools.exec_command(args));",
                "const args={cmd:'npm test'};mutate(\"tools.exec_command({label:'\",args,\"'})\");text(await tools.exec_command(args));"
                        + "function mutate(label,args,tail){args.cmd='rm -rf dist';}")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", source));
            records.add(output("exec", COMPLETED, "{\"exit_code\":0,\"output\":\"actual output\"}",
                    "{\"exit_code\":0,\"output\":\"later output\"}"));
            List<JsonObject> blocks = blocks(records);
            assertEquals(source, List.of("exec"), names(blocks));
            assertTrue(results(blocks).get(0).contains("actual output"));
            assertTrue(results(blocks).get(0).contains("later output"));
        }
    }

    /** Array transformations can replace literal jobs before the loop reaches the tool. */
    @Test
    public void keepsTransformedJobArraysReviewable() {
        for (String initializer : List.of("['npm test'].map(()=> 'git status')", "['npm test']\n.map(()=> 'git status')")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "const jobs=" + initializer + ";for(const cmd of jobs)text(await tools.exec_command({cmd}));"));
            records.add(output("exec", COMPLETED, "{\"exit_code\":0,\"output\":\"actual status\"}"));
            List<JsonObject> blocks = blocks(records);
            assertEquals(initializer, List.of("exec"), names(blocks));
            assertTrue(results(blocks).get(0).contains("actual status"));
        }
    }

    /** A closure declared earlier can mutate jobs after their literal initialization. */
    @Test
    public void keepsJobsCapturedBeforeTheirDeclarationReviewable() {
        for (String source : List.of(
                "const prepare=()=>{jobs[0]='git status';};const jobs=['npm test'];prepare();"
                        + "for(const cmd of jobs)text(await tools.exec_command({cmd}));",
                "const prepare=()=>{const alias=[...jobs];alias[0].cmd='git status';};const jobs=[{cmd:'npm test'}];prepare();"
                        + "for(const args of jobs)text(await tools.exec_command(args));")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", source));
            records.add(output("exec", COMPLETED, "{\"exit_code\":0,\"output\":\"actual status\"}"));
            List<JsonObject> blocks = blocks(records);
            assertEquals(source, List.of("exec"), names(blocks));
            assertTrue(results(blocks).get(0).contains("actual status"));
        }
    }

    /** Regex syntax and namespace aliases must not hide calls from the static inventory. */
    @Test
    public void keepsRegexAndNamespaceAliasesOpaque() {
        for (String source : List.of(
                "const ns=1?tools:null;await ns.exec_command({cmd:'rm -rf dist'});text(await tools.exec_command({cmd:'npm test'}));",
                "const a=/\"/;text(await tools.exec_command({cmd:'rm -rf dist'}));const b=/\"/;await tools.exec_command({cmd:'npm test'});",
                "const re=/[)]/;text(await tools.exec_command({cmd:'npm test'}));",
                "const args={cmd:'npm test'};mutate(/[)]/,args);text(await tools.exec_command(args));")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", source));
            records.add(output("exec", COMPLETED, "{\"exit_code\":0,\"output\":\"actual output\"}"));
            assertEquals(source, List.of("exec"), names(blocks(records)));
        }
    }

    /** Unsupported regex expressions keep both indexed local data and native tools available for review. */
    @Test
    public void keepsRegexLocalValuesInTheWrapper() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "const results=await Promise.allSettled([Promise.resolve(ALL_TOOLS.filter(x=>/jetbrains/i.test(x.name))),"
                + "tools.exec_command({cmd:'npm test'})]);results.forEach((r,i)=>text({i,...r}));"));
        records.add(command("native", "npm test", 0));
        records.add(output("exec", COMPLETED, "{\"i\":0,\"status\":\"fulfilled\",\"value\":[\"local catalog\"]}",
                "{\"i\":1,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"printed\"}}"));
        inventory(records.get(records.size() - 1).getAsJsonObject(), "exec", true,
                "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}}]");
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("exec", "bash"), names(blocks));
        assertTrue(results(blocks).contains("native output"));
        assertTrue(results(blocks).stream().anyMatch(result -> result.contains("local catalog")));
    }

    /** A complete tool inventory cannot discard local values from independent batches. */
    @Test
    public void keepsLocalValuesAcrossIndependentBatchInventories() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "const first=await Promise.all([tools.exec_command({cmd:'npm test'}),Promise.resolve('local value')]);"
                + "first.forEach((result,i)=>text({i,result}));await Promise.all([tools.exec_command({cmd:'git status'})]);"));
        records.add(command("tests", "npm test", 0));
        records.add(command("status", "git status", 0));
        JsonObject terminal = output("exec", COMPLETED, "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"printed\"}}",
                "{\"i\":1,\"result\":\"local value\"}");
        inventory(terminal, "exec", true, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}},"
                + "{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"git status\"}}]");
        records.add(terminal);
        assertTrue(names(blocks(records)).contains("exec"));
        assertTrue(results(blocks(records)).stream().anyMatch(result -> result.contains("local value")));
    }

    /** Braced Unicode escapes retain the actual command, including supplementary characters. */
    @Test
    public void decodesBracedUnicodeEscapes() {
        for (String escape : List.of("u{41}", "u{1F600}", "u{10ffff}")) {
            String decoded = new String(Character.toChars(Integer.parseInt(escape.substring(2, escape.length() - 1), 16)));
            JsonArray records = new JsonArray();
            records.add(call("exec", "text(await tools.exec_command({cmd:'echo " + '\\' + escape + "'}));"));
            records.add(output("exec", COMPLETED, "{\"exit_code\":0,\"output\":\"printed\"}"));
            JsonObject tool = blocks(records).get(0);
            assertEquals("bash", text(tool, "name"));
            assertEquals("echo " + decoded, text(tool.getAsJsonObject("input"), "command"));
        }
    }

    /** Malformed escapes cannot invent a command from an invalid historical string. */
    @Test
    public void keepsMalformedUnicodeEscapesOpaque() {
        for (String escape : List.of("u{}", "u{110000}", "u{zz}", "u{41", "u+041", "x+1", "u{ＦＦ}", "uＦＦＦＦ")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "text(await tools.exec_command({cmd:'echo " + '\\' + escape + "'}));"));
            records.add(output("exec", COMPLETED, "{\"exit_code\":0,\"output\":\"untrusted output\"}"));
            assertEquals(escape, List.of("exec"), names(blocks(records)));
        }
    }

    /** Long quoted identifiers and unrelated declarations must not multiply regex backtracking per tool. */
    @Test(timeout = 5000)
    public void replaysLongIdentifiersWithinTheParsingBudget() {
        for (String prefix : List.of("const note='" + "a1".repeat(25_000) + "';", java.util.stream.IntStream.range(0, 200)
                .mapToObj(index -> "const key" + index + "='value';").collect(java.util.stream.Collectors.joining()))) {
            StringBuilder source = new StringBuilder(prefix);
            List<String> outputs = new ArrayList<>();
            outputs.add(COMPLETED);
            for (int index = 0; index < 20; index++) {
                source.append("text(await tools.exec_command({cmd:'echo ").append(index).append("'}));");
                outputs.add("{\"exit_code\":0,\"output\":\"printed " + index + "\"}");
            }
            JsonArray records = new JsonArray();
            records.add(call("exec", source.toString()));
            records.add(output("exec", outputs.toArray(String[]::new)));
            assertEquals(20, names(blocks(records)).stream().filter("bash"::equals).count());
            assertEquals(20, results(blocks(records)).size());
        }
    }

    /** Buffered activity records keep their transcript position around an opaque wrapper. */
    @Test
    public void keepsInterleavedActivitiesInRecordedOrder() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "await tools[load('tool')](load('args'));"));
        for (String id : List.of("a1", "a2")) {
            JsonObject activity = JsonParser.parseString("{\"type\":\"event_msg\",\"payload\":{\"item\":{\"type\":\"SubAgentActivity\","
                    + "\"kind\":\"started\",\"agent_thread_id\":\"child\",\"agent_path\":\"/root/review\"}}}").getAsJsonObject();
            activity.getAsJsonObject("payload").addProperty("type", id.equals("a1") ? "item_started" : "item_completed");
            activity.getAsJsonObject("payload").getAsJsonObject("item").addProperty("id", id);
            records.add(activity);
        }
        records.add(output("exec", COMPLETED));
        assertEquals(List.of("exec", "a1-activity", "a2-activity", "exec"), blocks(records).stream()
                .map(block -> text(block, "tool_use".equals(text(block, "type")) ? "id" : "tool_use_id")).toList());
    }

    /** The receipt budget cannot remove the wrapper before its later script failure is known. */
    @Test
    public void keepsScriptFailuresAtTheReceiptLimit() {
        for (int count : List.of(99, 100, 101)) {
            JsonArray records = scope("turn");
            StringBuilder source = new StringBuilder();
            for (int index = 0; index < count; index++) {
                source.append("await tools.exec_command({cmd:'task ").append(index).append("'});");
            }
            records.add(call("exec", source + "throw new Error('boom');"));
            for (int index = 0; index < count; index++) {
                records.add(command("native-" + index, "task " + index, 0));
            }
            records.add(output("exec", "Script failed\nWall time 0.1 seconds\nOutput:\n", "Script error:\nboom"));
            List<JsonObject> blocks = blocks(records);
            assertTrue("count=" + count, names(blocks).contains("exec"));
            assertEquals(count, names(blocks).stream().filter("bash"::equals).count());
            List<String> ids = blocks.stream().filter(block -> "tool_use".equals(text(block, "type"))).map(block -> text(block, "id")).toList();
            assertTrue(blocks.stream().filter(block -> "tool_result".equals(text(block, "type"))).allMatch(block -> ids.contains(text(block, "tool_use_id"))));
            assertTrue(blocks.stream().anyMatch(block -> block.has("is_error") && block.get("is_error").getAsBoolean()
                    && text(block, "content").contains("boom")));
        }
    }

    /** A full budget and duplicate completions still wait for the real script outcome. */
    @Test
    public void replaysExactlyOneHundredCompletedReceipts() {
        JsonArray records = scope("turn");
        StringBuilder source = new StringBuilder();
        for (int index = 0; index < 100; index++) {
            source.append("await tools.exec_command({cmd:'task ").append(index).append("'});");
        }
        records.add(call("exec", source.toString()));
        for (int index = 0; index < 100; index++) {
            records.add(command("native-" + index, "task " + index, 0));
        }
        records.add(command("native-99", "task 99", 0));
        records.add(output("exec", COMPLETED));
        List<JsonObject> blocks = blocks(records);
        assertFalse(names(blocks).contains("exec"));
        assertEquals(100, names(blocks).stream().filter("bash"::equals).count());
        assertEquals(100, results(blocks).size());
    }

    /** EOF previews retain usage before the first assistant is emitted and reconcile after append. */
    @Test
    public void keepsUsageInEofPreviewsWithoutEarlierAssistant() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "await tools[load('tool')](load('args'));"));
        records.add(JsonParser.parseString("{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"last_token_usage\":{\"input_tokens\":123,\"output_tokens\":7}}}}"));
        List<JsonObject> committed = new ArrayList<>();
        var accumulator = new HistoryMessageInjector.CodexFrontendMessageAccumulator(committed::add, ignored -> { });
        records.forEach(record -> accumulator.accept(record.getAsJsonObject()));
        for (boolean completed : List.of(false, true)) {
            if (completed) {
                JsonObject terminal = output("exec", COMPLETED);
                records.add(terminal);
                accumulator.accept(terminal);
            }
            List<JsonObject> actual = new ArrayList<>(committed);
            actual.addAll(accumulator.pendingMessages());
            assertEquals(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records), actual);
            assertEquals(1, actual.stream().filter(message -> message.getAsJsonObject("raw").has("usage")).count());
        }
    }

    /** A usage snapshot waits for its buffered assistant rather than disappearing or updating an older turn. */
    @Test
    public void keepsUsageWhileExecIsBuffered() {
        for (String source : List.of("await tools[load('tool')](load('args'));", "text(await tools.exec_command({cmd:'npm test'}));")) {
            for (boolean yielded : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\","
                        + "\"content\":[{\"type\":\"output_text\",\"text\":\"earlier answer\"}]}}"));
                records.add(JsonParser.parseString("{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hi\"}}"));
                records.add(call("exec", source));
                if (yielded) {
                    records.add(output("exec", YIELDED));
                }
                records.add(JsonParser.parseString("{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{"
                        + "\"last_token_usage\":{\"input_tokens\":123,\"output_tokens\":7,\"cached_input_tokens\":0},\"model_context_window\":10000}}}"));
                if (yielded) {
                    records.add(waitCall("wait-1", "cell-1"));
                }
                records.add(output(yielded ? "wait-1" : "exec", COMPLETED, "{\"exit_code\":0,\"output\":\"passed\"}"));
                List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
                List<JsonObject> withUsage = messages.stream().filter(message -> message.getAsJsonObject("raw").has("usage")).toList();
                assertEquals(1, withUsage.size());
                assertFalse(withUsage.get(0).toString().contains("earlier answer"));
                assertEquals(123, withUsage.get(0).getAsJsonObject("raw").getAsJsonObject("usage").get("input_tokens").getAsInt());
            }
        }
    }

    /** Printed command success cannot replace a host-confirmed script termination. */
    @Test
    public void keepsTerminationAfterPrintedSuccessfulResult() {
        for (boolean yielded : List.of(false, true)) {
            for (boolean nativeReceipt : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(call("exec", "text(await tools.exec_command({cmd:'npm test'}));await new Promise(()=>{});"));
                if (nativeReceipt) {
                    records.add(command("native", "npm test", 0));
                }
                if (yielded) {
                    records.add(output("exec", YIELDED, "{\"exit_code\":0,\"output\":\"passed\"}"));
                    records.add(waitCall("wait-1", "cell-1"));
                }
                records.add(output(yielded ? "wait-1" : "exec", "Script terminated\nWall time 0.1 seconds\nOutput:\n",
                        "{\"exit_code\":0,\"output\":\"passed\"}"));
                List<JsonObject> blocks = blocks(records);
                assertTrue(names(blocks).contains("exec"));
                assertTrue(blocks.stream().anyMatch(block -> block.has("is_error") && block.get("is_error").getAsBoolean()
                        && text(block, "content").contains("Script terminated")));
            }
        }
    }

    /** Terminal host status survives CRLF headers and outputs arriving after a receipt-budget fallback. */
    @Test
    public void keepsHostTerminationAfterReleasingTheReplayBuffer() {
        for (int count : List.of(0, 101)) {
            for (String newline : List.of("\n", "\r\n")) {
                JsonArray records = scope("turn");
                records.add(call("exec", count == 0 ? "text(await tools.exec_command({cmd:'npm test'}));await new Promise(()=>{});"
                        : "for(const args of load('jobs'))await tools.exec_command(args);"));
                for (int index = 0; index < count; index++) {
                    records.add(command("native-" + index, "task " + index, 0));
                }
                records.add(output("exec", "Script terminated" + newline + "Wall time 0.1 seconds" + newline + "Output:" + newline,
                        "{\"exit_code\":0,\"output\":\"passed\"}"));
                List<JsonObject> blocks = blocks(records);
                assertTrue(names(blocks).contains("exec"));
                assertTrue(blocks.stream().anyMatch(block -> "exec".equals(text(block, "tool_use_id"))
                        && block.get("is_error").getAsBoolean() && text(block, "content").contains("Script terminated")));
            }
        }
    }

    private static JsonArray scope(String turn) {
        JsonArray records = new JsonArray();
        records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
        JsonObject context = JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{}}").getAsJsonObject();
        context.getAsJsonObject("payload").addProperty("turn_id", turn);
        records.add(context);
        return records;
    }

    /** Deferred reasoning keeps the lifecycle turn from its arrival, even when a cell spans turns. */
    @Test
    public void keepsDeferredReasoningInItsOriginalTurn() {
        for (boolean completed : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
            records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"turn\"}}"));
            records.add(call("exec", "text(await tools.exec_command({cmd:'npm test'}));"));
            records.add(command("native", "npm test", 0));
            records.add(output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n"));
            for (String turn : List.of("turn", "next-turn")) {
                records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"" + turn + "\"}}"));
                records.add(JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"summary\":[{\"text\":\"" + turn + " thought\"}]}}"));
            }
            if (completed) {
                records.add(waitCall("wait-1", "cell-1"));
                records.add(output("wait-1", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
            }
            List<JsonObject> thoughts = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).stream()
                    .filter(message -> message.toString().contains(" thought")).toList();
            assertEquals(2, thoughts.size());
            assertEquals(List.of("turn", "next-turn"), thoughts.stream()
                    .map(message -> text(message.getAsJsonObject("raw"), "codexTurnId")).toList());
        }
    }

    /** Missing arrival scope cannot be reconstructed from the turn that later completes the cell. */
    @Test
    public void leavesUnscopedDeferredReasoningUnscoped() {
        for (boolean completed : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "text(await tools.exec_command({cmd:'npm test'}));"));
            records.add(command("native", "npm test", 0));
            records.add(output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n"));
            records.add(JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"summary\":[{\"text\":\"unscoped thought\"}]}}"));
            records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"next-turn\"}}"));
            if (completed) {
                records.add(waitCall("wait-1", "cell-1"));
                records.add(output("wait-1", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
            }
            List<JsonObject> thoughts = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).stream()
                    .filter(message -> message.toString().contains("unscoped thought")).toList();
            assertEquals(1, thoughts.size());
            assertFalse(thoughts.get(0).getAsJsonObject("raw").has("codexTurnId"));
        }
    }

    /** Evaluated inventories retain the native lifecycle scope when model metadata names another turn. */
    @Test
    public void keepsInventoryReplayInTheNativeLifecycleTurn() {
        JsonArray records = new JsonArray();
        records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
        records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"turn\"}}"));
        JsonObject wrapper = call("exec", "await tools[load('tool')](load('args'));");
        wrapper.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough",
                JsonParser.parseString("{\"turn_id\":\"model-turn\"}"));
        records.add(wrapper);
        records.add(command("native", "npm test", 0));
        JsonObject terminal = output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n");
        inventory(terminal, "exec", true, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}}]");
        records.add(terminal);
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(List.of("bash"), names(blocks(records)));
        assertTrue(messages.stream().allMatch(message -> "turn".equals(text(message.getAsJsonObject("raw"), "codexTurnId"))));
    }

    /** Parameter names that begin with async remain identifiers in ordinary map callbacks. */
    @Test
    public void acceptsAsyncNamedMapParameters() {
        for (String parameter : List.of("asyncArgs", "async")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "const jobs=[{cmd:'npm test'},{cmd:'git status'}];await Promise.all(jobs.map("
                    + parameter + " => tools.exec_command(" + parameter + ")));"));
            records.add(command("status", "git status", 0));
            records.add(command("tests", "npm test", 0));
            records.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
            List<JsonObject> blocks = blocks(records);
            assertEquals(parameter, List.of("bash", "bash"), names(blocks));
            assertEquals(List.of("tests output", "status output"), results(blocks));
        }
    }

    /** A successful static tool receipt cannot hide an exception in the remaining JavaScript. */
    @Test
    public void retainsStaticScriptFailureAfterSuccessfulTools() {
        for (boolean nativeReceipt : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "text(await tools.exec_command({cmd:'npm test'}));throw new Error('validation failed');"));
            if (nativeReceipt) {
                records.add(command("native", "npm test", 0));
            }
            records.add(output("exec", "Script failed\nWall time 0.1 seconds\nOutput:\n", "{\"exit_code\":0,\"output\":\"passed\"}",
                    "Script error:\nvalidation failed"));
            List<JsonObject> blocks = blocks(records);
            if (nativeReceipt) {
                assertTrue(names(blocks).contains("bash"));
            }
            assertTrue(blocks.stream().anyMatch(block -> "tool_result".equals(text(block, "type"))
                    && block.get("is_error").getAsBoolean() && text(block, "content").contains("validation failed")));
        }
    }

    /** Host termination keeps its interrupted outcome in both direct and yielded replies. */
    @Test
    public void retainsTerminatedCellOutcome() {
        for (boolean yielded : List.of(false, true)) {
            for (boolean nativeReceipt : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(call("exec", "await tools.exec_command({cmd:'npm test'});await new Promise(()=>{});"));
                if (nativeReceipt) {
                    records.add(command("native", "npm test", 0));
                }
                if (yielded) {
                    records.add(output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n"));
                    records.add(waitCall("wait-1", "cell-1"));
                }
                records.add(output(yielded ? "wait-1" : "exec", "Script terminated\nWall time 0.1 seconds\nOutput:\n"));
                List<JsonObject> blocks = blocks(records);
                if (nativeReceipt) {
                    assertTrue(names(blocks).contains("bash"));
                }
                assertTrue(blocks.stream().anyMatch(block -> "tool_result".equals(text(block, "type"))
                        && block.get("is_error").getAsBoolean() && text(block, "content").contains("Script terminated")));
            }
        }
    }

    /** Yield fallback must keep actual file changes even when the cell has no final reply or inventory. */
    @Test
    public void retainsNativeFileChangesAcrossContinuationFallback() {
        for (boolean completed : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "await tools[load('tool')](load('args'));"));
            records.add(patch("saved", "a.ts", "created\n", "completed"));
            records.add(output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n"));
            if (completed) {
                records.add(waitCall("wait-1", "cell-1"));
                records.add(output("wait-1", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
            }
            List<JsonObject> blocks = blocks(records);
            assertTrue(names(blocks).contains("exec"));
            assertTrue(names(blocks).contains("file_change"));
            assertEquals(1, blocks.stream().filter(block -> "saved".equals(text(block, "id"))).count());
            assertEquals(1, blocks.stream().filter(block -> "saved".equals(text(block, "tool_use_id"))).count());
        }
    }

    /** Releasing a full replay buffer must not hide edits arriving during its next wait. */
    @Test
    public void keepsLateEditsAfterAReleasedCellStartsWaiting() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "for(const job of load('jobs'))await tools[load('tool')](job);"));
        records.add(output("exec", YIELDED));
        for (int index = 0; index < 101; index++) {
            records.add(command("native-" + index, "task " + index, 0));
        }
        records.add(waitCall("wait-1", "cell-1"));
        records.add(patch("late-edit", "saved.txt", "retained\n", "completed"));
        records.add(output("wait-1", COMPLETED));
        List<JsonObject> blocks = blocks(records);
        assertTrue(names(blocks).contains("exec"));
        assertEquals(1, blocks.stream().filter(block -> "late-edit".equals(text(block, "id"))).count());
        assertEquals(1, blocks.stream().filter(block -> "late-edit".equals(text(block, "tool_use_id"))).count());
    }

    /** A fallback cell must show a repeated native completion only once. */
    @Test
    public void keepsOneNativeCompletionWhenAFallbackRepeatsIt() {
        JsonArray records = new JsonArray();
        records.add(call("yielded", "await tools[load('tool')](load('args'));"));
        records.add(command("native", "npm test", 0));
        records.add(command("native", "npm test", 0));
        records.add(output("yielded", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n"));
        List<JsonObject> blocks = blocks(records);
        assertTrue(names(blocks).contains("exec"));
        assertEquals(1, blocks.stream().filter(block -> "native".equals(text(block, "id"))).count());
        assertEquals(1, blocks.stream().filter(block -> "native".equals(text(block, "tool_use_id"))).count());
    }

    /** Incomplete batches retain completed native results instead of replacing them with pending inputs. */
    @Test
    public void retainsPartialNativeBatchResultsAtEof() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "const jobs=['npm test','git status'];await Promise.all(jobs.map(cmd=>tools.exec_command({cmd})));"));
        records.add(command("first", "npm test", 1));
        List<JsonObject> blocks = blocks(records);
        assertTrue(names(blocks).contains("exec"));
        assertEquals(List.of("first output"), results(blocks));
        assertTrue(blocks.stream().anyMatch(block -> "first".equals(text(block, "tool_use_id")) && block.get("is_error").getAsBoolean()));
    }

    /** An initial yield before any invocation has no inventory and cannot invalidate a later complete one. */
    @Test
    public void restoresInventoryAfterAnEmptyInitialYield() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "await yield_control();await tools[load('tool')](load('args'));"));
        JsonObject yielded = output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n");
        yielded.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough", JsonParser.parseString("{\"turn_id\":\"turn\"}"));
        records.add(yielded);
        records.add(waitCall("wait-1", "cell-1"));
        records.add(command("native", "npm test", 0));
        JsonObject terminal = output("wait-1", "Script completed\nWall time 0.1 seconds\nOutput:\n");
        inventory(terminal, "exec", true, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}}]");
        records.add(terminal);
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash"), names(blocks));
        assertEquals(List.of("native output"), results(blocks));
    }

    /** Successful native tools cannot erase a later JavaScript orchestration error. */
    @Test
    public void retainsScriptFailureBesideACompleteInventory() {
        for (boolean failed : List.of(true, false)) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "await tools[load('tool')](load('args'));" + (failed ? "throw new Error('validation failed');" : "")));
            records.add(command("native", "npm test", 0));
            JsonObject terminal = output("exec", "Script " + (failed ? "failed" : "completed") + "\nWall time 0.1 seconds\nOutput:\n",
                    failed ? "Script error:\nvalidation failed" : "Script failed\nis only logged stdout");
            inventory(terminal, "exec", true, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}}]");
            records.add(terminal);
            List<JsonObject> blocks = blocks(records);
            if (failed) {
                assertTrue(names(blocks).contains("exec"));
                assertTrue(names(blocks).contains("bash"));
                assertTrue(blocks.stream().anyMatch(block -> "tool_result".equals(text(block, "type"))
                        && block.get("is_error").getAsBoolean() && text(block, "content").contains("validation failed")));
            } else {
                assertEquals(List.of("bash"), names(blocks));
                assertFalse(blocks.get(1).get("is_error").getAsBoolean());
            }
        }
    }

    /** Known neighbours cannot establish the outcome of a computed tool call or namespace alias. */
    @Test
    public void retainsComputedCallsBesideKnownCommands() {
        for (String dynamic : List.of("await tools[load('name')](load('args'));", "const runtime=tools;await runtime.invoke(load('args'));")) {
            for (boolean completeInventory : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(call("exec", "await tools.exec_command({cmd:'npm test'});" + dynamic));
                records.add(command("native", "npm test", 0));
                JsonObject terminal = output("exec", "Script completed\nOutput:\n", "dynamic result");
                if (completeInventory) {
                    records.add(command("dynamic", "git status", 1));
                    inventory(terminal, "exec", true, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}},"
                            + "{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"git status\"}}]");
                }
                records.add(terminal);
                List<JsonObject> blocks = blocks(records);
                if (completeInventory) {
                    assertEquals(dynamic, List.of("bash", "bash"), names(blocks));
                    assertEquals(List.of("native output", "dynamic output"), results(blocks));
                } else {
                    assertTrue(dynamic, names(blocks).contains("exec"));
                    assertTrue(results(blocks).stream().anyMatch(result -> result.contains("dynamic result")));
                }
            }
        }
        JsonArray literalProperty = new JsonArray();
        literalProperty.add(call("exec", "const sample={tools:[],functions:[]};await tools.exec_command({cmd:'npm test'});"));
        literalProperty.add(command("native", "npm test", 0));
        literalProperty.add(output("exec", "Script completed\nOutput:\n"));
        assertEquals(List.of("bash"), names(blocks(literalProperty)));
    }

    /** A tool-only inventory cannot discard local batch values already tied to their source slots. */
    @Test
    public void preservesLocalBatchDataBesideACompleteInventory() {
        for (boolean includeLocalResult : List.of(true, false)) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "const rs=await Promise.all([tools.exec_command({cmd:'npm test'}),Promise.resolve({note:'local data'})]);"
                    + "rs.forEach((result,i)=>text({i,result}));"));
            records.add(command("native", "npm test", 0));
            JsonObject terminal = includeLocalResult
                    ? output("exec", "Script completed\nOutput:\n", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"passed\"}}",
                            "{\"i\":1,\"result\":{\"note\":\"local data\"}}")
                    : output("exec", "Script completed\nOutput:\n", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"passed\"}}");
            inventory(terminal, "exec", true, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}}]");
            records.add(terminal);
            List<JsonObject> blocks = blocks(records);
            if (includeLocalResult) {
                assertEquals(List.of("bash", "Promise.resolve"), names(blocks));
                assertTrue(results(blocks).contains("{\"note\":\"local data\"}"));
            } else {
                assertTrue(names(blocks).contains("exec"));
            }
        }
    }

    /** Notification text cannot impersonate the host's completion or running header. */
    @Test
    public void waitsPastNotificationsThatResembleHostStatus() {
        for (String notification : List.of("Script completed", "Script running with cell ID example")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", "notify('" + notification + "');text(await tools.exec_command({cmd:'npm test'}));"));
            records.add(output("exec", notification));
            records.add(command("native", "npm test", 0));
            records.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
            assertEquals(notification, List.of("bash"), names(blocks(records)));
            assertEquals(List.of("native output"), results(blocks(records)));
        }
    }

    /** Deferred records without timestamps keep the identities assigned at their original positions. */
    @Test
    public void keepsDistinctDeferredReasoningIdentities() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "await tools.exec_command({cmd:'npm test'});"));
        records.add(output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n"));
        for (String thought : List.of("first thought", "second thought")) {
            records.add(JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"summary\":[{\"text\":\"" + thought + "\"}]}}"));
        }
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        List<String> identities = messages.stream().filter(message -> message.toString().contains("thought"))
                .map(message -> text(message.getAsJsonObject("raw"), "uuid")).toList();
        assertEquals(2, identities.size());
        assertEquals(2, identities.stream().distinct().count());
    }

    /** Earlier notifications must not hide a terminal failure in a projected web result. */
    @Test
    public void keepsFailureStatusAfterMergingNotificationOutput() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "notify('progress');text(await tools.web__run({search_query:[{q:'fixture'}]}));"));
        records.add(output("exec", "progress"));
        records.add(output("exec", "Script failed\nWall time 0.1 seconds\nOutput:\nactual failure"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("webSearch"), names(blocks));
        assertTrue(blocks.get(1).get("is_error").getAsBoolean());
        assertTrue(results(blocks).get(0).contains("actual failure"));
    }

    /** Tool-looking source inside a command or comment must remain literal data. */
    @Test
    public void leavesQuotedBracketToolNamesUntouched() {
        String command = "printf '%s' \"tools['exec_command'] functions[\\\"apply_patch\\\"]\"";
        JsonArray records = new JsonArray();
        records.add(call("exec", "// tools['view_image'] is an example\ntext(await tools['exec_command']({cmd:" + new JsonPrimitive(command) + "}));"));
        records.add(command("native", command, 0));
        records.add(output("exec", "Script completed\nOutput:\n", "{\"exit_code\":0,\"output\":\"printed example\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash"), names(blocks));
        assertEquals(command, text(blocks.get(0).getAsJsonObject("input"), "command"));
        assertEquals(List.of("native output"), results(blocks));
    }

    /** Merely referencing a settlement helper is valid source and does not start a batch. */
    @Test
    public void keepsBareSettlementHelperReferencesReviewable() {
        for (String script : List.of("as_settled", "const helper=stream_settled")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", script));
            records.add(output("exec", "Script completed\nOutput:\n"));
            assertEquals(script, List.of("exec"), names(blocks(records)));
        }
    }

    /** A complete call inventory cannot establish the outcome of a poll without a receipt. */
    @Test
    public void retainsInventoryPollsWithoutIndependentOutcomes() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "await tools[load('tool')](load('args'));"));
        JsonObject terminal = output("exec", "Script completed\nOutput:\n", "poll response");
        inventory(terminal, "exec", true, "[{\"name\":\"write_stdin\",\"arguments\":{\"session_id\":123}}]");
        records.add(terminal);
        assertEquals(List.of("exec"), names(blocks(records)));
        assertTrue(results(blocks(records)).get(0).contains("poll response"));
    }

    /** Native errors remain visible even when the failed dynamic call has no content items. */
    @Test
    public void showsNativeDynamicFailureDetails() {
        JsonArray records = new JsonArray();
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"DynamicToolCall","id":"failed-dynamic","namespace":"browser","tool":"browse",
                "arguments":{},"status":"failed","error":"browser disconnected"}}}
                """));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("browser.browse"), names(blocks));
        assertTrue(blocks.get(1).get("is_error").getAsBoolean());
        assertTrue(blocks.get(1).get("content").toString().contains("browser disconnected"));
    }

    /** Non-object dynamic arguments stay readable under the same key as the live projection. */
    @Test
    public void keepsDynamicNonObjectArgumentsReadable() {
        for (String arguments : List.of("\"payload text\"", "null")) {
            JsonArray records = new JsonArray();
            records.add(JsonParser.parseString("""
                    {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                    "item":{"type":"DynamicToolCall","id":"dynamic","namespace":"files","tool":"write",
                    "arguments":%s,"status":"completed","success":true,"content_items":[]}}}
                    """.formatted(arguments)));
            List<JsonObject> blocks = blocks(records);
            assertEquals(arguments, List.of("files.write"), names(blocks));
            JsonObject input = blocks.get(0).getAsJsonObject("input");
            assertEquals(arguments, "null".equals(arguments) ? "" : "payload text", text(input, "patch"));
            assertFalse(arguments, input.has("arguments"));
        }
    }

    /** Equivalent relative paths match native absolute paths without borrowing another file's identity. */
    @Test
    public void matchesNormalizedPatchPathsOneToOne() {
        String first = "*** Begin Patch\n*** Add File: ./a.ts\n+first\n*** End Patch";
        String second = "*** Begin Patch\n*** Add File: src/../b.ts\n+second\n*** End Patch";
        JsonArray records = new JsonArray();
        records.add(call("exec", "await Promise.all([tools.apply_patch(" + new JsonPrimitive(first) + "),tools.apply_patch(" + new JsonPrimitive(second) + ")]);"));
        records.add(patch("patch-b", "/repo/b.ts", "second\n", "completed"));
        records.add(patch("patch-a", "/repo/a.ts", "first\n", "completed"));
        records.add(output("exec", "Script completed\nOutput:\n"));
        assertEquals(List.of("file_change", "file_change"), names(blocks(records)));
        assertEquals(List.of("patch-a", "patch-b"), blocks(records).stream().filter(block -> "tool_use".equals(text(block, "type")))
                .map(block -> text(block, "id")).toList());

        JsonArray mismatched = new JsonArray();
        mismatched.add(call("exec", "await tools.apply_patch(" + new JsonPrimitive(first.replace("./a.ts", "a.ts")
                .replace("*** End Patch", "*** Add File: nested/a.ts\n+other\n*** End Patch")) + ");"));
        JsonObject receipt = patch("mismatched", "/repo/nested/a.ts", "first\n", "completed");
        JsonObject extra = new JsonObject();
        extra.addProperty("type", "add");
        extra.addProperty("content", "unrelated\n");
        receipt.getAsJsonObject("payload").getAsJsonObject("item").getAsJsonObject("changes").add("/repo/unrelated.ts", extra);
        mismatched.add(receipt);
        mismatched.add(output("exec", "Script completed\nOutput:\n"));
        assertTrue(names(blocks(mismatched)).contains("exec"));
    }

    /** Finite maps and awaited loops keep the evaluated inputs and each native command's outcome. */
    @Test
    public void unpacksObjectStringAndLabelledJobs() {
        List<String> scripts = List.of(
                "const jobs=[{cmd:'npm test'},{cmd:'git status'}];await Promise.all(jobs.map(args=>tools.exec_command(args)));",
                "const jobs=[{cmd:'npm test'},{cmd:'git status'}]\nawait Promise.all(jobs.map(args=>tools.exec_command(args)));",
                "const jobs=['npm test','git status']\nfor(const cmd of jobs)text(await tools.exec_command({cmd}));",
                "const jobs=['npm test','git status'];await Promise.allSettled(jobs.map(async cmd=>await tools.exec_command({cmd,workdir:'/repo'})));",
                "const jobs=[['tests',{cmd:'npm test'}],['status',{cmd:'git status'}]];"
                        + "await Promise.allSettled(jobs.map(async ([label,args])=>({label,...await tools.exec_command({...args,workdir:'/repo'})})));",
                "const jobs=[{cmd:'npm test'},{cmd:'git status'}];await Promise.all(jobs.map(args=>{return tools.exec_command(args);}));",
                "const jobs=[{cmd:'npm test'},{cmd:'git status'}];for(const args of jobs){text(await tools.exec_command(args));}",
                "const jobs=['npm test','git status'];for(const cmd of jobs)text(await tools.exec_command({cmd,workdir:'/repo'}));",
                "const jobs=[['tests',{cmd:'npm test'}],['status',{cmd:'git status'}]];for(const [label,args] of jobs){text(await tools.exec_command({...args}));}"
        );
        for (String script : scripts) {
            JsonArray records = new JsonArray();
            records.add(call("exec", script));
            for (String command : script.contains("for(") ? List.of("npm test", "git status") : List.of("git status", "npm test")) {
                records.add(command(command, command, command.equals("npm test") ? 1 : 0));
            }
            records.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
            List<JsonObject> blocks = blocks(records);
            assertEquals(script, List.of("bash", "bash"), names(blocks));
            assertEquals(List.of("npm test", "git status"), blocks.stream().filter(block -> "tool_use".equals(text(block, "type")))
                    .map(block -> text(block.getAsJsonObject("input"), "command")).toList());
            assertEquals(List.of(true, false), blocks.stream().filter(block -> "tool_result".equals(text(block, "type")))
                    .map(block -> block.get("is_error").getAsBoolean()).toList());
        }
    }

    /** Literal bindings and bracket access are read statically; mutation never borrows a native outcome. */
    @Test
    public void readsLiteralArgumentsSpreadsAndBracketToolNames() {
        for (String source : List.of(
                "const args={cmd:'npm test'};text(await tools.exec_command(args));",
                "const options={workdir:'/repo'};text(await tools.exec_command({...options,cmd:'npm test'}));",
                "const prefix='npm ';text(await tools.exec_command({cmd:prefix+'test'}));",
                "const run=tools.exec_command;text(await run({cmd:'npm test'}));",
                "const {exec_command:run}=tools;text(await run({cmd:'npm test'}));",
                "const {exec_command}=tools;text(await exec_command({cmd:'npm test'}));",
                "text(await tools['exec_command']({cmd:'npm test'}));",
                "text(await tools[\"exec_command\"]({cmd:'npm test'}));")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", source));
            records.add(command("test", "npm test", 0));
            records.add(output("exec", "{\"exit_code\":0,\"output\":\"success\"}"));
            assertEquals(source, List.of("bash"), names(blocks(records)));
        }
        for (String source : List.of(
                "const args={cmd:'npm test'};args.cmd='git status';await tools.exec_command(args);",
                "const args={cmd:'npm test'};mutate(args);await tools.exec_command(args);",
                "const args={cmd:'npm test'};const alias=args;alias.cmd='git status';await tools.exec_command(args);",
                "const run=tools.exec_command;const alias=run;await run({cmd:'npm test'});",
                "const run=tools.exec_command;function nested(run){return run({cmd:'npm test'});}",
                "const cmd='npm test';values.map(cmd=>tools.exec_command({cmd}));",
                "await tools[computed]({cmd:'npm test'});")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", source));
            records.add(command("test", "npm test", 0));
            records.add(output("exec", "shared output"));
            assertTrue(source, names(blocks(records)).contains("exec"));
        }
    }

    /** Shared literal defaults may be reused through serialized arguments without allowing mutation or aliases. */
    @Test
    public void reusesLiteralDefaultsAcrossCallsAndMappedJobs() {
        for (String script : List.of(
                "const options={workdir:'/repo'};await tools.exec_command({...options,cmd:'npm test'});await tools.exec_command({...options,cmd:'git status'});",
                "const options={workdir:'/repo'};const jobs=['npm test','git status'];"
                        + "await Promise.all(jobs.map(cmd=>tools.exec_command({...options,cmd})));",
                "const run=tools.exec_command;const jobs=[{cmd:'npm test'},{cmd:'git status'}];await Promise.all(jobs.map(args=>run(args)));")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", script));
            records.add(command("status", "git status", 0));
            records.add(command("tests", "npm test", 0));
            records.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
            assertEquals(script, List.of("bash", "bash"), names(blocks(records)));
        }
    }

    /** Settlement helpers own numeric array slots even when they deliver results out of order. */
    @Test
    public void restoresAsSettledAndStreamSettledArrays() {
        for (String script : List.of(
                "for await(const result of as_settled([tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'git status'})]))text(result);",
                "await stream_settled([tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'git status'})],text);")) {
            JsonArray records = new JsonArray();
            records.add(call("exec", script));
            records.add(output("exec", "{\"index\":1,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"status\"}}",
                    "{\"index\":0,\"status\":\"rejected\",\"reason\":\"rejected tests\"}"));
            List<JsonObject> blocks = blocks(records);
            assertEquals(script, List.of("bash", "bash"), names(blocks));
            assertEquals(List.of("rejected tests", "status"), results(blocks));
        }
    }

    /** Map settlement keys preserve their JSON type and cannot borrow another slot's result. */
    @Test
    public void restoresNamedSettlementSlotsAndRejectsDuplicateKeys() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "await stream_settled(new Map([['tests',tools.exec_command({cmd:'npm test'})],"
                + "[10.0,tools.exec_command({cmd:'git status'})],['10',Promise.resolve({status:'failed',value:'local data'})]]),text);"));
        records.add(output("exec", "{\"index\":10,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"status\"}}",
                "{\"index\":\"10\",\"status\":\"fulfilled\",\"value\":{\"status\":\"failed\",\"value\":\"local data\"}}",
                "{\"index\":\"tests\",\"status\":\"rejected\",\"reason\":\"tests rejected\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash", "bash", "Promise.resolve"), names(blocks));
        assertEquals(List.of("tests rejected", "status", "{\"status\":\"failed\",\"value\":\"local data\"}"), results(blocks));
        assertFalse(blocks.get(5).get("is_error").getAsBoolean());

        for (String keys : List.of("['same',tools.exec_command({cmd:'npm test'})],['same',tools.exec_command({cmd:'git status'})]",
                "[computed,tools.exec_command({cmd:'npm test'})]")) {
            JsonArray ambiguous = new JsonArray();
            ambiguous.add(call("exec", "await stream_settled(new Map([" + keys + "]),text);"));
            ambiguous.add(output("exec", "{\"index\":\"same\",\"status\":\"fulfilled\",\"value\":{\"exit_code\":0}}"));
            assertTrue(names(blocks(ambiguous)).contains("exec"));
        }
    }

    /** Complete host inventories can identify dynamic source without treating completeness as success. */
    @Test
    public void restoresEvaluatedInventoryOnlyWithIndependentResults() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "const run=tools[load('tool')];for(const job of load('jobs'))await run(job);"));
        records.add(command("second", "git status", 0));
        records.add(command("first", "npm test", 2));
        JsonObject output = output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n", "{\"exit_code\":0}");
        inventory(output, "exec", true, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}},"
                + "{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"git status\"}}]");
        records.add(output);
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash", "bash"), names(blocks));
        assertEquals(List.of("first output", "second output"), results(blocks));
        assertTrue(blocks.get(1).get("is_error").getAsBoolean());

        for (String calls : List.of(
                "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"missing outcome\"}}]",
                "[{\"name\":\"exec_command\",\"arguments\":{\"_codex_executed_tool_call_truncated\":{\"original_bytes\":9999}}}]")) {
            JsonArray incomplete = new JsonArray();
            incomplete.add(call("exec", "await tools[load('tool')](load('args'));"));
            JsonObject terminal = output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n", "kept output");
            inventory(terminal, "exec", true, calls);
            incomplete.add(terminal);
            assertTrue(names(blocks(incomplete)).contains("exec"));
            assertTrue(results(blocks(incomplete)).stream().anyMatch(result -> result.contains("kept output")));
        }
        for (String cell : List.of("other-cell", "exec")) {
            JsonArray incomplete = new JsonArray();
            incomplete.add(call("exec", "await tools[load('tool')](load('args'));"));
            incomplete.add(command("first", "npm test", 0));
            JsonObject terminal = output("exec", "done");
            inventory(terminal, cell, false, "[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"npm test\"}}]");
            incomplete.add(terminal);
            assertTrue(names(blocks(incomplete)).contains("exec"));
        }
    }

    /** Native dynamic calls retain typed media and their own failure instead of borrowing exec's success. */
    @Test
    public void restoresNativeDynamicToolsAndDeclinedCommands() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "const fn=tools[load('tool')];await fn(load('arguments'));"));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"DynamicToolCall","id":"dynamic","namespace":"browser","tool":"browse",
                "arguments":{"url":"https://example.test"},"status":"completed","success":false,
                "content_items":[{"type":"inputText","text":"remote error"},{"type":"inputImage","imageUrl":"data:image/png;base64,fixture"}]}}}
                """));
        JsonObject terminal = output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n");
        inventory(terminal, "exec", true, "[{\"name\":\"browser__browse\",\"arguments\":{\"url\":\"https://example.test\"}}]");
        records.add(terminal);
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("browser.browse"), names(blocks));
        assertTrue(blocks.get(1).get("is_error").getAsBoolean());
        JsonArray content = blocks.get(1).getAsJsonArray("content");
        assertEquals("text", text(content.get(0).getAsJsonObject(), "type"));
        assertEquals("image", text(content.get(1).getAsJsonObject(), "type"));
        assertEquals("data:image/png;base64,fixture", text(content.get(1).getAsJsonObject().getAsJsonObject("source"), "url"));

        JsonArray declined = new JsonArray();
        declined.add(call("exec", "text(await tools.exec_command({cmd:'npm test'}));"));
        JsonObject command = command("declined", "npm test", 0);
        command.getAsJsonObject("payload").getAsJsonObject("item").addProperty("status", "declined");
        command.getAsJsonObject("payload").getAsJsonObject("item").remove("exit_code");
        declined.add(command);
        declined.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
        List<JsonObject> rejected = blocks(declined);
        assertEquals(List.of("bash"), names(rejected));
        assertTrue(rejected.get(1).get("is_error").getAsBoolean());
    }

    /** Parallel file changes are paired by affected files rather than their completion order. */
    @Test
    public void pairsParallelPatchesByTheirFileIdentities() {
        String first = "*** Begin Patch\n*** Add File: a.ts\n+first\n*** End Patch";
        String second = "*** Begin Patch\n*** Add File: b.ts\n+second\n*** End Patch";
        JsonArray records = new JsonArray();
        records.add(call("exec", "await Promise.allSettled([tools.apply_patch(" + new JsonPrimitive(first)
                + "),tools.apply_patch(" + new JsonPrimitive(second) + ")]);"));
        records.add(patch("patch-b", "b.ts", "second\n", "failed"));
        records.add(patch("patch-a", "a.ts", "first\n", "completed"));
        records.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("file_change", "file_change"), names(blocks));
        assertEquals(List.of("patch-a", "patch-b"), blocks.stream().filter(block -> "tool_use".equals(text(block, "type")))
                .map(block -> text(block, "id")).toList());
        assertEquals(List.of(false, true), blocks.stream().filter(block -> "tool_result".equals(text(block, "type")))
                .map(block -> block.get("is_error").getAsBoolean()).toList());
    }

    /** Limits release the buffered wrapper before later native records, preserving every actual call. */
    @Test
    public void preservesCallsBeyondTheReplayLimitAndRepeatedNotificationBodies() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "for(const args of load('jobs'))await tools.exec_command(args);"));
        for (int index = 0; index < 103; index++) {
            records.add(command("native-" + index, "task " + index, 0));
        }
        records.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n"));
        assertEquals(103, names(blocks(records)).stream().filter("bash"::equals).count());
        assertTrue(names(blocks(records)).contains("exec"));

        JsonArray notifications = new JsonArray();
        notifications.add(call("exec", "notify('first');notify('second');await tools[computed](args);"));
        notifications.add(output("exec", "first"));
        notifications.add(output("exec", "second"));
        notifications.add(output("exec", "Script failed\nWall time 0.1 seconds\nOutput:\n", "Script error:\nactual failure"));
        List<JsonObject> blocks = blocks(notifications);
        assertEquals(List.of("exec"), names(blocks));
        assertEquals(1, results(blocks).size());
        assertTrue(results(blocks).get(0).contains("first"));
        assertTrue(results(blocks).get(0).contains("second"));
        assertTrue(results(blocks).get(0).contains("actual failure"));
        assertTrue(blocks.get(1).get("is_error").getAsBoolean());
    }

    /** A yielded cell consumes only its matching wait and keeps earlier indexed output. */
    @Test
    public void joinsYieldedExecAndItsWaitResults() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "const rs=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'git status'})]);for(let i=0;i<rs.length;i++)text({i,...rs[i]});"));
        records.add(output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n",
                "{\"i\":0,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"tests\"}}"));
        records.add(JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"summary\":[{\"text\":\"waiting\"}]}}"));
        records.add(waitCall("wait-1", "cell-1"));
        records.add(output("wait-1", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n"));
        records.add(waitCall("wait-2", "cell-1"));
        records.add(output("wait-2", "Script completed\nWall time 0.1 seconds\nOutput:\n",
                "{\"i\":1,\"status\":\"fulfilled\",\"value\":{\"exit_code\":1,\"output\":\"status failed\"}}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash", "bash"), names(blocks));
        assertEquals(List.of("tests", "status failed"), results(blocks));
        assertTrue(blocks.stream().anyMatch(block -> "thinking".equals(text(block, "type"))));
    }

    /** Notifications add output without ending exec, while incomplete cells retain their script and replies. */
    @Test
    public void retainsNotificationsAndUnfinishedOrMismatchedWaits() {
        JsonArray records = new JsonArray();
        records.add(call("exec", "await tools.exec_command({cmd:'npm test'});notify('progress');await tools.exec_command({cmd:'git status'});"));
        records.add(output("exec", "{\"exit_code\":0,\"output\":\"tests\"}"));
        records.add(output("exec", "Script completed\nWall time 0.1 seconds\nOutput:\n", "{\"exit_code\":0,\"output\":\"status\"}"));
        assertEquals(List.of("bash", "bash"), names(blocks(records)));
        assertEquals(List.of("tests", "status"), results(blocks(records)));

        JsonArray unfinished = new JsonArray();
        unfinished.add(call("exec", "await tools.exec_command({cmd:'npm test'});"));
        unfinished.add(output("exec", "Script running with cell ID cell-1\nWall time 0.1 seconds\nOutput:\n", "initial output"));
        unfinished.add(waitCall("wrong-wait", "cell-other"));
        unfinished.add(output("wrong-wait", "unrelated wait output"));
        List<JsonObject> blocks = blocks(unfinished);
        assertTrue(names(blocks).contains("exec"));
        assertTrue(names(blocks).contains("wait"));
        assertTrue(results(blocks).stream().anyMatch(result -> result.contains("initial output")));
        assertTrue(results(blocks).stream().anyMatch(result -> result.contains("unrelated wait output")));
    }

    private static JsonObject command(String id, String command, int exitCode) {
        JsonObject record = JsonParser.parseString("{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"thread_id\":\"root\",\"turn_id\":\"turn\","
                + "\"item\":{\"type\":\"CommandExecution\",\"status\":\"completed\"}}}").getAsJsonObject();
        JsonObject item = record.getAsJsonObject("payload").getAsJsonObject("item");
        item.addProperty("id", id);
        item.addProperty("command", command);
        item.addProperty("exit_code", exitCode);
        item.addProperty("status", exitCode == 0 ? "completed" : "failed");
        item.addProperty("aggregated_output", id + " output");
        return record;
    }

    private static JsonObject patch(String id, String path, String content, String status) {
        JsonObject record = command(id, "", 0);
        JsonObject item = record.getAsJsonObject("payload").getAsJsonObject("item");
        item.addProperty("type", "FileChange");
        item.addProperty("status", status);
        JsonObject change = new JsonObject();
        change.addProperty("type", "add");
        change.addProperty("content", content);
        JsonObject changes = new JsonObject();
        changes.add(path, change);
        item.add("changes", changes);
        return record;
    }

    private static JsonObject call(String id, String source) {
        JsonObject record = JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec\"}}").getAsJsonObject();
        record.getAsJsonObject("payload").addProperty("call_id", id);
        record.getAsJsonObject("payload").addProperty("input", source);
        return record;
    }

    private static JsonObject waitCall(String id, String cellId) {
        JsonObject record = call(id, "");
        JsonObject payload = record.getAsJsonObject("payload");
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "wait");
        payload.addProperty("arguments", "{\"cell_id\":\"" + cellId + "\"}");
        return record;
    }

    private static JsonObject output(String id, String... texts) {
        JsonObject record = JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\"}}").getAsJsonObject();
        JsonObject payload = record.getAsJsonObject("payload");
        if (id.contains("wait")) {
            payload.addProperty("type", "function_call_output");
        }
        payload.addProperty("call_id", id);
        JsonArray body = new JsonArray();
        for (String text : texts) {
            JsonObject block = new JsonObject();
            block.addProperty("type", "input_text");
            block.addProperty("text", text);
            body.add(block);
        }
        payload.add("output", body);
        return record;
    }

    private static void inventory(JsonObject output, String cellId, boolean complete, String calls) {
        JsonObject metadata = new JsonObject();
        metadata.addProperty("cell_id", cellId);
        metadata.addProperty("tool_calls_complete", complete);
        metadata.add("executed_tool_calls", JsonParser.parseString(calls));
        output.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough", metadata);
    }

    private static List<JsonObject> blocks(JsonArray records) {
        List<JsonObject> blocks = new ArrayList<>();
        for (JsonObject message : HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records)) {
            for (JsonElement block : message.getAsJsonObject("raw").getAsJsonArray("content")) {
                blocks.add(block.getAsJsonObject());
            }
        }
        return blocks;
    }

    private static List<String> names(List<JsonObject> blocks) {
        return blocks.stream().filter(block -> "tool_use".equals(text(block, "type"))).map(block -> text(block, "name")).toList();
    }

    private static List<String> results(List<JsonObject> blocks) {
        return blocks.stream().filter(block -> "tool_result".equals(text(block, "type"))).map(block -> text(block, "content")).toList();
    }

    private static String text(JsonObject object, String key) {
        return HistoryMessageInjector.getStringProperty(object, key);
    }
}
