package com.github.claudecodegui.handler.history;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Replays the mixed wrappers reported by the user without executing their source. */
public class CodexKnownExecReplayTest {
    private static final String PATCH = "*** Begin Patch\n*** Add File: a.ts\n+created\n*** End Patch";

    /** A thrown native edit ends the sequence before the later literal command runs. */
    @Test
    public void restoresNativePatchFailureWithoutInventingTheLaterCommand() {
        JsonArray records = new JsonArray();
        records.add(call("stopped-patch", "text(await tools.apply_patch(" + new com.google.gson.JsonPrimitive(PATCH)
                + "));text(await tools.exec_command({cmd:'npm test'}));"));
        JsonObject failed = nativePatch();
        failed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("status", "failed");
        records.add(failed);
        records.add(output("stopped-patch", "Script failed\nWall time 0.0 seconds\nOutput:\n",
                "Script error:\napply_patch verification failed: expected line missing"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("file_change"), toolNames(projected));
        assertTrue(projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                .allMatch(block -> block.get("is_error").getAsBoolean()));
    }

    /** An explicit verification error owns the first literal patch even without a native item. */
    @Test
    public void restoresTheFirstPatchVerificationFailureFromItsRecordedError() {
        JsonArray records = new JsonArray();
        records.add(call("unrecorded-patch", "text(await tools.apply_patch(" + new com.google.gson.JsonPrimitive(PATCH)
                + "));text(await tools.exec_command({cmd:'npm test'}));"));
        records.add(output("unrecorded-patch", "Script failed\nWall time 0.0 seconds\nOutput:\n",
                "Script error:\napply_patch verification failed: expected line missing"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("apply_patch"), toolNames(projected));
        assertEquals(List.of("Script error:\napply_patch verification failed: expected line missing"), results(projected));
        assertTrue(projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                .allMatch(block -> block.get("is_error").getAsBoolean()));
    }

    /** A parallel batch failure cannot prove that its other actions never executed. */
    @Test
    public void keepsAnUnresolvedParallelPatchFailure() {
        JsonArray records = new JsonArray();
        records.add(call("parallel-patch", "await Promise.all([tools.apply_patch(" + new com.google.gson.JsonPrimitive(PATCH)
                + "),tools.exec_command({cmd:'npm test'})]);"));
        records.add(output("parallel-patch", "Script failed\nWall time 0.0 seconds\nOutput:\n",
                "Script error:\napply_patch verification failed: expected line missing"));
        assertTrue(toolNames(blocks(records)).contains("exec"));
    }

    /** A clock receipt beside raw stdout must not hide the command behind its wrapper. */
    @Test
    public void restoresCommandStdoutBesideTheCurrentTimeReceipt() {
        JsonArray records = new JsonArray();
        records.add(call("clock-command", "const r=await tools.exec_command({cmd:'npm test'});"
                + "text(r.output);text(await tools.clock__curr_time({}));"));
        records.add(nativeCommand("clock-command-native", "completed", 0));
        records.add(output("clock-command", "stdout without a JSON envelope",
                "{\"current_time\":\"2026-10-04 06:32:46 UTC\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "clock__curr_time"), toolNames(projected));
        assertEquals(List.of("clock-command-native output", "{\"current_time\":\"2026-10-04 06:32:46 UTC\"}"), results(projected));
    }

    /** Indexed clock and command outcomes keep the Promise slot's identity. */
    @Test
    public void restoresIndexedClockOutcomesWithoutMixingCommandResults() {
        JsonArray records = new JsonArray();
        records.add(call("clock-batch", "const rs=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.clock__curr_time({})]);rs.forEach((r,i)=>text({i,result:r.value}));"));
        records.add(nativeCommand("clock-batch-native", "completed", 0));
        records.add(output("clock-batch", "{\"i\":1,\"result\":{\"current_time\":\"2026-10-04 06:32:46 UTC\"}}",
                "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"command result\"}}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "clock__curr_time"), toolNames(projected));
        assertEquals(2, results(projected).size());
        assertTrue(results(projected).get(1).contains("current_time"));
    }

    /** A missing or ambiguous clock receipt preserves the script for review. */
    @Test
    public void keepsClockWrappersWhenTheReceiptCannotBeProven() {
        for (String[] receipts : List.of(new String[0], new String[] {
                "{\"current_time\":\"2026-10-04 06:32:46 UTC\"}",
                "{\"current_time\":\"2026-10-04 06:32:47 UTC\"}" })) {
            JsonArray records = new JsonArray();
            records.add(call("uncertain-clock", "text(await tools.exec_command({cmd:'npm test'}));"
                    + "text(await tools.clock__curr_time({}));"));
            records.add(nativeCommand("uncertain-clock-native", "completed", 0));
            records.add(output("uncertain-clock", receipts));
            assertTrue(toolNames(blocks(records)).contains("exec"));
        }
    }

    /** A delayed completion from an earlier wrapper cannot invalidate an indexed batch. */
    @Test
    public void separatesEarlierProcessReceiptsFromTheCurrentBatch() {
        JsonArray records = new JsonArray();
        records.add(call("current-batch", "const rs=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'git status'})]);"
                + "rs.forEach((r,i)=>text({i,...(r.status==='fulfilled'?{result:r.value}:{error:String(r.reason)})}));"));
        JsonObject second = nativeCommand("current-second", "completed", 0);
        second.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "git status");
        records.add(second);
        JsonObject previous = nativeCommand("earlier-command", "completed", 0);
        previous.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "gradle test");
        records.add(previous);
        records.add(nativeCommand("current-first", "completed", 0));
        records.add(output("current-batch", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"first\"}}",
                "{\"i\":1,\"result\":{\"exit_code\":0,\"output\":\"second\"}}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash", "bash"), toolNames(projected));
        assertEquals(3, results(projected).size());
        assertTrue(projected.stream().anyMatch(block -> "earlier-command".equals(string(block, "id"))));
    }

    /** Late native output closes the original process and later polls cannot add a duplicate result. */
    @Test
    public void lateNativeCompletionClosesTheOriginalRunningCommandWithoutAnotherCard() {
        JsonArray records = new JsonArray();
        records.add(call("previous-process", "text(await tools.exec_command({cmd:'gradle test'}));"));
        records.add(output("previous-process", "{\"session_id\":19,\"output\":\"building\"}"));
        records.add(call("current-batch", "const rs=await Promise.allSettled([tools.exec_command({cmd:'npm test'})]);"));
        JsonObject previous = nativeCommand("earlier-command", "failed", 2);
        previous.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "gradle test");
        records.add(previous);
        records.add(nativeCommand("current-command", "completed", 0));
        records.add(output("current-batch", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"current passed\"}}"));
        records.add(call("poll", "text(await tools.write_stdin({session_id:19,chars:''}));"));
        records.add(output("poll", "{\"exit_code\":2,\"output\":\"already recorded\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("current-command output", "earlier-command output"), results(projected));
        assertTrue(projected.stream().anyMatch(block -> "previous-process:command:0".equals(string(block, "tool_use_id"))
                && block.get("is_error").getAsBoolean()));
    }

    /** Literal callback labels associate following receipts with their original Promise slots. */
    @Test
    public void restoresLabeledCommandAndPollReceiptsFromTheRecordedBatch() {
        JsonArray records = new JsonArray();
        records.add(call("previous", "text(await tools.exec_command({cmd:'gradle test'}));"));
        records.add(output("previous", "{\"session_id\":18,\"output\":\"building\"}"));
        records.add(call("labeled", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'git status'}),"
                + "tools.write_stdin({session_id:18,chars:''})]);"
                + "results.forEach((r,i)=>{text(`VERIFY ${i}`);text(r.status==='fulfilled'?r.value:r.reason)});"));
        records.add(output("labeled", "VERIFY 0", "{\"exit_code\":0,\"output\":\"tests passed\"}",
                "VERIFY 1", "{\"exit_code\":1,\"output\":\"status failed\"}",
                "VERIFY 2", "{\"exit_code\":0,\"output\":\"build passed\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash", "bash"), toolNames(projected));
        assertEquals(List.of("tests passed", "status failed", "build passed"), results(projected));
        assertTrue(projected.stream().anyMatch(block -> "previous:command:0".equals(string(block, "tool_use_id"))));
    }

    /** Whole settled receipts keep fulfilled output and rejected work in their own labeled slots. */
    @Test
    public void restoresLabeledWholeSettledReceiptsWithIndependentRejection() {
        JsonArray records = new JsonArray();
        records.add(call("whole-labeled", "const rs=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'git status'})]);rs.forEach((r,i)=>{text(`RESULT ${i}`);text(r)});"));
        records.add(output("whole-labeled", "RESULT 0", "{\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"passed\"}}",
                "RESULT 1", "{\"status\":\"rejected\",\"reason\":\"command unavailable\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("passed", "command unavailable"), results(projected));
        assertFalse(projected.get(1).get("is_error").getAsBoolean());
        assertTrue(projected.get(3).get("is_error").getAsBoolean());
    }

    /** Tool-looking source strings cannot manufacture the array index of an unindexed result. */
    @Test
    public void rejectsUnprovenOrRepeatedTextLabels() {
        String script = "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'git status'})]);"
                + "results.forEach((r,i)=>{text(`READ ${i}`);text(r.value)});";
        for (List<String> labels : List.of(List.of("READ 0", "READ 0"), List.of("READ 0", "READ 9"))) {
            JsonArray records = new JsonArray();
            records.add(call("invalid-label", script));
            records.add(output("invalid-label", labels.get(0), "{\"exit_code\":0,\"output\":\"one\"}",
                    labels.get(1), "{\"exit_code\":0,\"output\":\"two\"}"));
            assertTrue(toolNames(blocks(records)).contains("exec"));
        }
        JsonArray quoted = new JsonArray();
        quoted.add(call("quoted-label", "const note=" + new Gson().toJson(script)
                + ";await Promise.allSettled([tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'git status'})]);"));
        quoted.add(output("quoted-label", "READ 0", "{\"exit_code\":0}", "READ 1", "{\"exit_code\":0}"));
        assertTrue(toolNames(blocks(quoted)).contains("exec"));
    }

    /** Image receipts and unindexed text results can share an allSettled wrapper. */
    @Test
    public void detachedNativeCommandsKeepBothStreamsAndTheActualExecutable() {
        JsonArray records = new JsonArray();
        JsonObject nativeRecord = nativeCommand("detached", "failed", 1);
        JsonObject item = nativeRecord.getAsJsonObject("payload").getAsJsonObject("item");
        item.add("command", JsonParser.parseString("[\"pwsh.exe\",\"-Command\",\"& node node_modules/vitest/vitest.mjs run src/hooks/useSubagents.test.ts\"]"));
        item.remove("formatted_output");
        item.addProperty("stdout", "testing");
        item.addProperty("stderr", "failed to load test");
        records.add(nativeRecord);
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash"), toolNames(projected));
        assertEquals("Run node", string(projected.get(0).getAsJsonObject("input"), "description"));
        assertTrue(string(projected.get(0).getAsJsonObject("input"), "command").startsWith("& node "));
        assertEquals(List.of("testing\nfailed to load test"), results(projected));
        assertTrue(projected.get(1).get("is_error").getAsBoolean());
        JsonObject executable = nativeCommand("argv", "completed", 0);
        executable.getAsJsonObject("payload").getAsJsonObject("item").add("command",
                JsonParser.parseString("[\"rg\",\"-n\",\"two words\",\"a.ts\"]"));
        JsonArray direct = new JsonArray();
        direct.add(executable);
        assertEquals("rg -n \"two words\" a.ts", string(blocks(direct).get(0).getAsJsonObject("input"), "command"));
    }

    /** Image receipts and unindexed text results can share an allSettled wrapper. */
    @Test
    public void restoresMixedImagesAndUnindexedCommandFromTheReportedBatch() {
        for (boolean nativeCommand : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(call("mixed-images", "const rs=await Promise.allSettled(["
                    + "tools.view_image({path:'first.png'}),tools.view_image({path:'second.png'}),"
                    + "tools.exec_command({cmd:'npm test'})]);"
                    + "for(let i=0;i<rs.length;i++){const r=rs[i];if(r.status!=='fulfilled'){text({i,error:String(r.reason)});continue;}"
                    + "if(i<2)image(r.value.image_url);else text(r.value);}"));
            records.add(nativeImage("first-view", "first.png"));
            records.add(nativeImage("second-view", "second.png"));
            if (nativeCommand) {
                records.add(nativeCommand("command-view", "completed", 0));
            }
            records.add(output("mixed-images", "Script completed\nOutput:\n", "{\"exit_code\":0,\"output\":\"tests passed\"}"));
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("imageView", "imageView", "bash"), toolNames(projected));
            assertEquals(List.of("", "", nativeCommand ? "command-view output" : "tests passed"), results(projected));
        }
    }

    /** Native image events may finish in the opposite order from the literal array. */
    @Test
    public void restoresImageViewsByPathRatherThanCompletionOrder() {
        JsonArray records = new JsonArray();
        records.add(call("reverse-images", "await Promise.all([tools.view_image({path:'first.png'}),"
                + "tools.view_image({path:'second.png'})]);"));
        records.add(nativeImage("second-view", "second.png"));
        records.add(nativeImage("first-view", "first.png"));
        records.add(output("reverse-images", "Script completed"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("first-view", "second-view"), projected.stream().filter(block -> block.has("id"))
                .map(block -> string(block, "id")).toList());
    }

    /** Native file URIs preserve encoded spaces, plus signs and network-share identity. */
    @Test
    public void associatesEncodedImageReceiptsWithTheirFilesystemInputs() {
        for (List<String> paths : List.of(
                List.of("C:/repo/first image+copy.png", "file:///C:/repo/first%20image+copy.png"),
                List.of("//server/repo/first image.png", "file://server/repo/first%20image.png"),
                List.of("C:/repo/first image.png", "file:///C:/repo/first image.png"))) {
            JsonArray records = new JsonArray();
            records.add(call("encoded-images", "await Promise.all([tools.view_image({path:" + new Gson().toJson(paths.get(0))
                    + "}),tools.exec_command({cmd:'npm test'})]);"));
            records.add(nativeImage("encoded-view", paths.get(1)));
            records.add(output("encoded-images", "{\"exit_code\":0,\"output\":\"tests passed\"}"));
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("imageView", "bash"), toolNames(projected));
            assertEquals("encoded-view", projected.get(0).get("id").getAsString());
        }
    }

    /** Condensed Promise output keeps each command's native result and original array slot. */
    @Test
    public void restoresDirectIndexedResultsWithoutBorrowingTheBatchOutcome() {
        String script = "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'gradle test'})]);"
                + "results.forEach((r,i)=>text({i,...(r.status==='fulfilled'?{result:r.value}:{error:String(r.reason)})}));";
        for (boolean nativeReceipts : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(call("direct-results", script));
            if (nativeReceipts) {
                records.add(nativeCommand("native-first", "completed", 0));
                JsonObject second = nativeCommand("native-second", "failed", 2);
                second.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "gradle test");
                records.add(second);
                assertEquals(List.of("bash", "bash"), toolNames(blocks(records)));
                assertEquals(List.of("native-first output", "native-second output"), results(blocks(records)));
            }
            records.add(output("direct-results", "Script completed\nOutput:\n",
                    "{\"i\":1,\"result\":{\"exit_code\":2,\"output\":\"java failed\"}}",
                    "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"frontend passed\"}}"));
            List<JsonObject> blocks = blocks(records);
            assertEquals(List.of("bash", "bash"), toolNames(blocks));
            assertEquals(nativeReceipts ? List.of("native-first output", "native-second output")
                    : List.of("frontend passed", "java failed"), results(blocks));
            assertEquals(List.of(false, true), blocks.stream().filter(block -> block.has("is_error"))
                    .map(block -> block.get("is_error").getAsBoolean()).toList());
        }
    }

    /** Direct indexed polling closes its original process while a sibling command keeps running. */
    @Test
    public void directIndexedPollingRetainsItsOriginalProcess() {
        JsonArray records = new JsonArray();
        records.add(call("first-direct", "text(await tools.exec_command({cmd:'gradle test'}));"));
        records.add(output("first-direct", "{\"session_id\":30450,\"output\":\"building\"}"));
        records.add(call("direct-poll", "const results=await Promise.allSettled(["
                + "tools.write_stdin({session_id:30450,chars:''}),"
                + "tools.exec_command({cmd:'playwright test'})]);"));
        records.add(output("direct-poll", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"java passed\"}}",
                "{\"i\":1,\"result\":{\"session_id\":84822,\"output\":\"browser started\"}}"));
        records.add(call("finish-direct", "text(await tools.write_stdin({session_id:84822,chars:''}));"));
        records.add(output("finish-direct", "{\"exit_code\":1,\"output\":\"browser failed\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(blocks));
        assertEquals(List.of("java passed", "browser failed"), results(blocks));
        assertEquals(blocks.stream().filter(block -> block.has("id")).map(block -> string(block, "id")).toList(),
                blocks.stream().filter(block -> block.has("tool_use_id")).map(block -> string(block, "tool_use_id")).toList());
    }

    /** Direct indexed web text keeps its own result beside a failed command. */
    @Test
    public void restoresDirectIndexedWebAndCommandResults() {
        JsonArray records = new JsonArray();
        records.add(call("direct-web", "await Promise.allSettled([tools.web__run({open:[{ref_id:'https://example.com'}]}),"
                + "tools.exec_command({cmd:'npm test'})]);"));
        records.add(output("direct-web", "{\"i\":0,\"result\":\"Retrieved page\"}",
                "{\"i\":1,\"result\":{\"exit_code\":1,\"output\":\"tests failed\"}}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("webSearch", "bash"), toolNames(blocks));
        assertEquals(List.of("Retrieved page", "tests failed"), results(blocks));
        assertFalse(blocks.get(1).get("is_error").getAsBoolean());
        assertTrue(blocks.get(3).get("is_error").getAsBoolean());
    }

    /** An explicit indexed rejection belongs to its own command, independently of siblings. */
    @Test
    public void restoresRejectedDirectResultsWithoutFailingItsSuccessfulSibling() {
        String script = "await Promise.allSettled([tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'gradle test'})]);";
        for (String invalid : List.of("{\"i\":0,\"error\":\"transport rejected\"}",
                "{\"i\":0,\"result\":{\"status\":\"rejected\",\"reason\":\"transport rejected\"}}",
                "{\"i\":0,\"status\":\"rejected\",\"reason\":\"transport rejected\"}")) {
            JsonArray records = new JsonArray();
            records.add(call("direct-rejection", script));
            records.add(output("direct-rejection", invalid, "{\"i\":1,\"result\":{\"exit_code\":0}}"));
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("bash", "bash"), toolNames(projected));
            assertEquals(List.of("transport rejected", ""), results(projected));
            assertEquals(List.of(true, false), projected.stream().filter(block -> block.has("is_error"))
                    .map(block -> block.get("is_error").getAsBoolean()).toList());
        }
    }

    /** A failed image slot does not consume another image's native receipt or the command output. */
    @Test
    public void restoresMixedBatchWithOneRejectedImage() {
        JsonArray records = new JsonArray();
        records.add(call("partial-images", "await Promise.allSettled([tools.view_image({path:'missing.png'}),"
                + "tools.view_image({path:'present.png'}),tools.exec_command({cmd:'npm test'})]);"));
        records.add(nativeImage("present-view", "present.png"));
        records.add(output("partial-images", "{\"i\":0,\"error\":\"Image does not exist\"}",
                "{\"exit_code\":0,\"output\":\"tests passed\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("imageView", "imageView", "bash"), toolNames(projected));
        assertEquals(List.of("Image does not exist", "", "tests passed"), results(projected));
        assertEquals(List.of(true, false, false), projected.stream().filter(block -> block.has("is_error"))
                .map(block -> block.get("is_error").getAsBoolean()).toList());
    }

    /** Without indices or native receipts, multiple command outcomes are still ambiguous. */
    @Test
    public void keepsUnindexedCommandsWithoutIndependentReceiptsReviewable() {
        JsonArray records = new JsonArray();
        records.add(call("ambiguous-direct", "await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'gradle test'})]);"));
        records.add(output("ambiguous-direct", "{\"exit_code\":0,\"output\":\"first\"}",
                "{\"exit_code\":1,\"output\":\"second\"}"));
        assertTrue(toolNames(blocks(records)).contains("exec"));
    }

    /** Recorded edits prove computed patches without executing the wrapper source. */
    @Test
    public void restoresComputedPatchWithoutBorrowingTheFailedPollOutcome() {
        JsonArray records = new JsonArray();
        records.add(call("computed", "const value='x'.repeat(3);text(await tools.apply_patch('prefix'+value));"
                + "text(await tools.write_stdin({session_id:123,chars:''}));"));
        records.add(nativePatch());
        records.add(output("computed", "{}", "{\"exit_code\":1,\"output\":\"build failed\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("file_change"), toolNames(blocks));
        assertEquals(List.of("saved"), results(blocks));
        assertFalse(blocks.get(1).get("is_error").getAsBoolean());
        JsonArray missing = new JsonArray();
        missing.add(records.get(0));
        missing.add(records.get(2));
        assertTrue(toolNames(blocks(missing)).contains("exec"));
    }

    /** Indexed results can wrap the Promise receipt under result alongside later sequential work. */
    @Test
    public void restoresNestedIndexedResultsAndTheLaterSequentialCommand() {
        JsonArray records = new JsonArray();
        records.add(call("nested", "text(await tools.apply_patch(" + new Gson().toJson(PATCH) + "));"
                + "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'gradle test'})]);results.forEach((result,i)=>text({i,result}));"
                + "text(await tools.exec_command({cmd:'git status'}));"));
        records.add(nativePatch());
        records.add(output("nested", "{}", "{\"i\":0,\"result\":{\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"frontend\"}}}",
                "{\"i\":1,\"result\":{\"status\":\"fulfilled\",\"value\":{\"exit_code\":1,\"output\":\"java\"}}}",
                "{\"exit_code\":0,\"output\":\"status\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("file_change", "bash", "bash", "bash"), toolNames(blocks));
        assertEquals(List.of("saved", "frontend", "java", "status"), results(blocks));
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        for (JsonObject message : messages) {
            assertEquals("root", string(message.getAsJsonObject("raw"), "codexThreadId"));
            assertEquals("turn", string(message.getAsJsonObject("raw"), "codexTurnId"));
        }
    }

    /** A native MCP receipt preserves the recorded tool and its terminal result. */
    @Test
    public void restoresMcpWrapperFromItsNativeReceipt() {
        JsonArray records = new JsonArray();
        records.add(call("mcp", "text(await tools.mcp__codex_app__open_in_codex({target:{type:'file',path:'report.md'}}));"));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"McpToolCall","id":"mcp-native","server":"codex_app","tool":"open_in_codex",
                "arguments":{"target":{"type":"file","path":"report.md"}},"status":"completed",
                "result":{"content":[{"type":"text","text":"queued"}],"isError":false}}}}
                """));
        records.add(output("mcp", "Script completed\nOutput:\n", "{\"isError\":false}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("open_in_codex"), toolNames(blocks));
        assertEquals("mcp-native", string(blocks.get(1), "tool_use_id"));
        assertFalse(blocks.get(1).get("is_error").getAsBoolean());
        assertEquals("queued", blocks.get(1).getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
    }

    /** Native failures, empty results and incomplete receipts keep their actual state. */
    @Test
    public void mcpReceiptsKeepNativeFailuresAndNeverBorrowOtherArguments() {
        for (String status : List.of("completed", "failed", "declined", "interrupted", "inProgress")) {
            JsonObject event = JsonParser.parseString("""
                    {"type":"event_msg","payload":{"type":"item_completed","item":{
                    "type":"McpToolCall","id":"native","server":"server","tool":"inspect",
                    "arguments":{},"status":"completed","result":null}}}
                    """).getAsJsonObject();
            JsonObject item = event.getAsJsonObject("payload").getAsJsonObject("item");
            item.addProperty("status", status);
            JsonArray receipts = new JsonArray();
            receipts.add(event);
            List<JsonObject> blocks = blocks(receipts);
            assertEquals(List.of("inspect"), toolNames(blocks));
            assertEquals(status.equals("inProgress") ? 0 : 1, results(blocks).size());
            if (blocks.size() > 1) assertEquals(!status.equals("completed"), blocks.get(1).get("is_error").getAsBoolean());
            item.add("result", JsonParser.parseString("{\"isError\":true,\"content\":[]}"));
            item.addProperty("status", "completed");
            assertTrue(blocks(receipts).get(1).get("is_error").getAsBoolean());
            item.add("error", JsonParser.parseString("{\"message\":\"native failure\"}"));
            assertTrue(results(blocks(receipts)).get(0).contains("native failure"));
            JsonArray mismatch = new JsonArray();
            mismatch.add(call("mismatch", "await tools.mcp__server__inspect({path:'different'});"));
            mismatch.add(event);
            mismatch.add(output("mismatch", "Script completed"));
            assertTrue(toolNames(blocks(mismatch)).contains("exec"));
        }
    }

    /** Conflicting native thread identities cannot make unrelated work look like one batch. */
    @Test
    public void refusesToBorrowAmbiguousNativeScopes() {
        JsonArray records = new JsonArray();
        records.add(call("ambiguous-scope", "await tools.apply_patch(" + new Gson().toJson(PATCH)
                + ");text(await tools.exec_command({cmd:'npm test'}));"));
        records.add(nativePatch());
        JsonObject command = nativeCommand("command", "completed", 0);
        command.getAsJsonObject("payload").addProperty("thread_id", "another-root");
        records.add(command);
        records.add(output("ambiguous-scope", "{\"exit_code\":0,\"output\":\"completed\"}"));
        assertTrue(toolNames(blocks(records)).contains("exec"));
    }

    private static JsonObject nativePatch() {
        return JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"FileChange","id":"native-patch","status":"completed",
                "changes":{"a.ts":{"type":"add","content":"created\\n"}},"stdout":"saved"}}}
                """).getAsJsonObject();
    }

    /** Keeps native patch outcomes and each independently indexed command result. */
    @Test
    public void replacesMixedPatchAndCommandsWithoutLeavingAnExecCard() {
        JsonArray records = new JsonArray();
        records.add(call("mixed", "text(await tools.apply_patch(" + new Gson().toJson(PATCH) + "));"
                + "const results = await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'gradle test'})]);results.forEach((r,i)=>text({i,...r}));"));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"FileChange","id":"native-patch","status":"completed",
                "changes":{"a.ts":{"type":"add","content":"created\\n"}},"stdout":"saved"}}}
                """));
        records.add(output("mixed", indexed(0, "{\"exit_code\":0,\"output\":\"frontend passed\"}"),
                indexed(1, "{\"exit_code\":1,\"output\":\"java failed\"}")));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("file_change", "bash", "bash"), toolNames(blocks));
        assertEquals(1, blocks.stream().filter(block -> "native-patch".equals(string(block, "id"))).count());
        assertEquals(List.of("saved", "frontend passed", "java failed"), results(blocks));
        assertTrue(blocks.stream().anyMatch(block -> block.has("is_error") && block.get("is_error").getAsBoolean()));
    }

    /** Poll results belong to earlier processes, never to the command beside them. */
    @Test
    public void mapsPollingAndCommandIndicesAndFinishesTheOriginalProcess() {
        JsonArray records = new JsonArray();
        records.add(call("first", "text(await tools.exec_command({cmd:'gradle test'}));"));
        records.add(output("first", "{\"session_id\":30450,\"output\":\"building\"}"));
        records.add(call("mixed", "const results=await Promise.allSettled(["
                + "tools.write_stdin({session_id:30450,chars:''}),"
                + "tools.write_stdin({session_id:45943,chars:''}),"
                + "tools.exec_command({cmd:'playwright test'})]);results.forEach((r,i)=>text({i,...r}));"));
        records.add(output("mixed", indexed(0, "{\"exit_code\":0,\"output\":\"java passed\"}"),
                indexed(1, "{\"exit_code\":0,\"output\":\"untracked poll\"}"),
                indexed(2, "{\"session_id\":84822,\"output\":\"browser started\"}")));
        records.add(call("last", "text(await tools.write_stdin({session_id:84822,chars:''}));"));
        records.add(output("last", "{\"exit_code\":0,\"output\":\"browser passed\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(blocks));
        assertEquals(List.of("java passed", "browser passed"), results(blocks));
        List<String> toolIds = blocks.stream().filter(block -> "tool_use".equals(string(block, "type")))
                .map(block -> string(block, "id")).toList();
        assertEquals(toolIds, blocks.stream().filter(block -> "tool_result".equals(string(block, "type")))
                .map(block -> string(block, "tool_use_id")).toList());
    }

    /** A background command from another turn cannot replace this wrapper's work. */
    @Test
    public void preservesUnrecognizedWorkAndRejectsForeignNativeOutcomes() {
        for (String script : List.of(
                "await tools.exec_command({cmd:'pwd'});await tools.view_image({path:'image.png'});",
                "await tools.exec_command({cmd:computed});",
                "await tools.write_stdin({session_id:1,chars:'exit'});await tools.exec_command({cmd:'pwd'});")) {
            JsonArray records = new JsonArray();
            records.add(call("unknown", script));
            records.add(output("unknown", "combined output"));
            assertTrue(toolNames(blocks(records)).contains("exec"));
        }
        JsonArray records = new JsonArray();
        JsonObject request = call("foreign", "await tools.apply_patch(" + new Gson().toJson(PATCH)
                + ");await tools.exec_command({cmd:'pwd'});");
        request.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough",
                JsonParser.parseString("{\"turn_id\":\"this-turn\"}"));
        records.add(request);
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","turn_id":"other-turn",
                "item":{"type":"FileChange","id":"foreign-edit","status":"completed","changes":[]}}}
                """));
        records.add(output("foreign", "combined output"));
        assertFalse(blocks(records).stream().anyMatch(block -> "foreign-edit".equals(string(block, "id"))));
    }

    /** Native completions take precedence over a conflicting outer JSON result and deduplicate repeated items. */
    @Test
    public void trustsNativeCommandOutcomesAndCompletesImageViews() {
        JsonArray records = new JsonArray();
        records.add(call("native", "await tools.exec_command({cmd:'npm test',summary:'Run tests'});"
                + "await tools.view_image({path:'image.png'});"));
        JsonObject nativeCommand = JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"CommandExecution","id":"command","status":"completed","exit_code":0,
                "command":["pwsh.exe","-Command","npm test"],"stdout":"failed is just stdout"}}}
                """).getAsJsonObject();
        records.add(nativeCommand);
        records.add(nativeCommand.deepCopy());
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"ImageView","id":"image","path":"image.png","status":"completed"}}}
                """));
        records.add(output("native", "{\"exit_code\":1,\"output\":\"wrong shared output\"}"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash", "imageView"), toolNames(blocks));
        assertEquals(List.of("failed is just stdout", ""), results(blocks));
        assertFalse(blocks.stream().anyMatch(block -> block.has("is_error") && block.get("is_error").getAsBoolean()));
        assertEquals("Run tests", blocks.get(0).getAsJsonObject("input").get("description").getAsString());
    }

    /** Fractional, duplicate and foreign result slots cannot silently claim the neighboring command. */
    @Test
    public void retainsWrappersWithAmbiguousResultIndices() {
        String script = "const results=await Promise.allSettled([tools.write_stdin({session_id:1,chars:''}),"
                + "tools.exec_command({cmd:'npm test'})]);results.forEach((r,i)=>text({i,...r}));";
        String commandResult = indexed(1, "{\"exit_code\":0,\"output\":\"passed\"}");
        for (String malformed : List.of(
                "{\"i\":0.5,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0}}",
                "{\"i\":\"0\",\"status\":\"fulfilled\",\"value\":{\"exit_code\":0}}",
                indexed(-1, "{\"exit_code\":0}"), indexed(99, "{\"exit_code\":0}"),
                "{\"i\":0,\"status\":\"rejected\",\"reason\":\"failed\"}")) {
            JsonArray records = new JsonArray();
            records.add(call("ambiguous", script));
            records.add(output("ambiguous", malformed, commandResult));
            assertTrue(malformed, toolNames(blocks(records)).contains("exec"));
        }
        JsonArray duplicate = new JsonArray();
        duplicate.add(call("duplicate", script));
        duplicate.add(output("duplicate", commandResult, commandResult));
        assertTrue(toolNames(blocks(duplicate)).contains("exec"));
    }

    /** Rejecting ambiguous indexed command results must not reassign them through the legacy fallback. */
    @Test
    public void ambiguousCommandOnlyResultsStayOpaque() {
        JsonArray records = new JsonArray();
        records.add(call("ambiguous-commands", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'gradle test'})]);"
                + "results.forEach((result,i)=>text({i,result}));"));
        records.add(output("ambiguous-commands", indexed(0, "{\"exit_code\":0,\"output\":\"first\"}"),
                indexed(0, "{\"exit_code\":1,\"output\":\"other\"}")));
        assertTrue(toolNames(blocks(records)).contains("exec"));
        JsonObject loop = call("repeated", "for(let i=0;i<2;i++){await tools.exec_command({cmd:'npm test'});}");
        CodexKnownExecReplay pending = CodexKnownExecReplay.begin(loop, null);
        pending.rememberNative(nativeCommand("first-native", "completed", 0));
        pending.rememberNative(nativeCommand("second-native", "completed", 0));
        List<JsonObject> preview = pending.snapshot(new java.util.LinkedHashMap<>());
        assertEquals("exec", string(preview.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject(), "name"));
    }

    /** Only numeric terminal codes establish completion; partial and missing command outputs stay observable. */
    @Test
    public void rejectsUntypedAndMissingCommandResults() {
        String script = "const results=await Promise.allSettled([tools.write_stdin({session_id:1,chars:''}),"
                + "tools.exec_command({cmd:'npm test'})]);";
        for (String result : List.of("{}", "{\"exit_code\":\"0\"}", "{\"exit_code\":0.5}",
                "{\"exit_code\":null}", "{\"session_id\":{}}")) {
            JsonArray records = new JsonArray();
            records.add(call("missing", script));
            records.add(output("missing", indexed(1, result)));
            assertTrue(result, toolNames(blocks(records)).contains("exec"));
        }
    }

    /** Comments and nested array commas cannot shift the result slot or hide unrecognized work. */
    @Test
    public void respectsPromiseArraySlotsAndSourceBoundaries() {
        JsonArray records = new JsonArray();
        records.add(call("comments", "/* tools.future_tool() */const results=await Promise.allSettled(["
                + "tools.write_stdin({session_id:1,chars:''}),// empty poll\n"
                + "tools.exec_command({cmd:'npm test',label:'tools.future_tool()',args:[1,2]}),]);"));
        records.add(output("comments", indexed(0, "{\"exit_code\":0}"),
                indexed(1, "{\"exit_code\":0,\"output\":\"correct slot\"}")));
        assertEquals(List.of("bash"), toolNames(blocks(records)));
        assertEquals(List.of("correct slot"), results(blocks(records)));
        for (String script : List.of(
                "await Promise.allSettled([Promise.resolve('other work'),tools.exec_command({cmd:'npm test'})]);",
                "await Promise.allSettled([tools.exec_command({cmd:'npm test'}),...extra]);",
                "await tools.exec_command({cmd:true});await tools.write_stdin({session_id:1,chars:''});",
                "await tools.exec_command({cmd:'npm test'});await tools.future_tool({});")) {
            JsonArray unknown = new JsonArray();
            unknown.add(call("unknown", script));
            unknown.add(output("unknown", indexed(0, "{\"exit_code\":0}"), indexed(1, "{\"exit_code\":0}")));
            assertTrue(script, toolNames(blocks(unknown)).contains("exec"));
        }
    }

    /** Thread and turn boundaries exclude unrelated receipts while repeated identical commands keep separate identities. */
    @Test
    public void scopesNativeReceiptsAndAcceptsArgumentEnvelopes() {
        JsonArray records = new JsonArray();
        records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
        JsonObject request = call("arguments", "await tools.exec_command({cmd:'npm test'});"
                + "await tools.shell_command({command:'npm test'});");
        JsonObject payload = request.getAsJsonObject("payload");
        payload.add("arguments", payload.remove("input"));
        payload.add("internal_chat_message_metadata_passthrough", JsonParser.parseString("{\"turn_id\":\"own\"}"));
        records.add(request);
        for (String scope : List.of("{\"thread_id\":\"foreign\",\"turn_id\":\"own\"}",
                "{\"thread_id\":\"root\",\"turn_id\":\"foreign\"}")) {
            JsonObject event = nativeCommand("foreign", "completed", 0);
            JsonObject fields = JsonParser.parseString(scope).getAsJsonObject();
            fields.entrySet().forEach(field -> event.getAsJsonObject("payload").add(field.getKey(), field.getValue()));
            records.add(event);
        }
        records.add(nativeCommand("first", "failed", 2));
        records.add(nativeCommand("second", "completed", 0));
        records.add(output("arguments", "shared output is not an independent result"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(blocks));
        assertEquals(List.of("first", "second"), blocks.stream().filter(block -> "tool_use".equals(string(block, "type")))
                .map(block -> string(block, "id")).toList());
        assertEquals(List.of("first output", "second output"), results(blocks));
        assertEquals(List.of(true, false), blocks.stream().filter(block -> "tool_result".equals(string(block, "type")))
                .map(block -> block.get("is_error").getAsBoolean()).toList());
    }

    /** EOF previews retain all visible literal inputs without turning empty polling into another card. */
    @Test
    public void previewsMixedInputsWithoutInventingCompletion() {
        JsonArray records = new JsonArray();
        records.add(call("pending", "await tools.write_stdin({session_id:1});await tools.view_image({path:'x.png'});"
                + "await tools.apply_patch(" + new Gson().toJson(PATCH) + ");"));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("imageView", "apply_patch"), toolNames(blocks));
        assertTrue(results(blocks).isEmpty());
        assertEquals("unknown", blocks.get(1).getAsJsonObject("input").get("status").getAsString());
        JsonArray poll = new JsonArray();
        poll.add(call("pending-poll", "await tools.write_stdin({session_id:1});"));
        assertTrue(blocks(poll).isEmpty());
    }

    /** A following message cannot resurrect an opaque wrapper whose own native completion is already known. */
    @Test
    public void commitsNativeCompletionAtTheFollowingMessageBoundary() {
        JsonArray records = new JsonArray();
        records.add(call("complete", "await tools.exec_command({cmd:'npm test'});"));
        records.add(nativeCommand("finished", "completed", 0));
        records.add(JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"message","role":"assistant",
                "content":[{"type":"output_text","text":"done"}]}}
                """));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("bash"), toolNames(blocks));
        assertEquals(List.of("finished output"), results(blocks));
        assertEquals("done", string(blocks.get(blocks.size() - 1), "text"));
    }

    /** Web result strings keep their own Promise slot and do not turn neighboring command results into web output. */
    @Test
    public void restoresWebSearchAndCommandResultsWithoutAnExecCard() {
        JsonArray records = new JsonArray();
        records.add(call("web-mixed", "const results=await Promise.allSettled(["
                + "tools.web__run({open:[{ref_id:'https://example.com'}],response_length:'short'}),"
                + "tools.exec_command({cmd:'npm test'})]);results.forEach((r,i)=>text({i,...r}));"));
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"Extension","kind":"web.search","id":"native-web","query":"https://example.com",
                "action":{"type":"openPage","url":"https://example.com"},"results":[]}}}
                """));
        records.add(output("web-mixed", indexed(0, new Gson().toJson("Web page body\nfailed is quoted page text")),
                indexed(1, "{\"exit_code\":0,\"output\":\"command passed\"}")));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("webSearch", "bash"), toolNames(blocks));
        assertEquals(List.of("Web page body\nfailed is quoted page text", "command passed"), results(blocks));
        assertFalse(blocks.stream().anyMatch(block -> block.has("is_error") && block.get("is_error").getAsBoolean()));
    }

    /** Pending wrapper previews keep the web item id when its independent result arrives. */
    @Test
    public void pendingWebPreviewKeepsTheCompletedToolIdentity() {
        JsonArray records = new JsonArray();
        records.add(call("web-pending", "text(await tools.web__run({search_query:[{q:'fixture'}]}));"));
        String pendingId = string(blocks(records).get(0), "id");
        records.add(output("web-pending", "Script completed\nOutput:\nfull page"));
        assertEquals(pendingId, string(blocks(records).get(0), "id"));
        assertEquals(List.of("full page"), results(blocks(records)));
    }

    /** A completed native extension has a terminal result even without a separate wrapper output or status. */
    @Test
    public void restoresStandaloneNativeWebReceipts() {
        JsonArray records = new JsonArray();
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"Extension","kind":"web.search","id":"native-web","query":"fixture",
                "action":{"type":"search","query":"fixture"},"results":[]}}}
                """));
        List<JsonObject> blocks = blocks(records);
        assertEquals(List.of("webSearch"), toolNames(blocks));
        assertEquals(1, results(blocks).size());
        assertEquals("native-web", string(blocks.get(1), "tool_use_id"));
    }

    /** A single literal web wrapper can consume its own text output and preserve a real script failure. */
    @Test
    public void restoresSingleWebTextResultsAndRetainsIncompleteMixedWork() {
        for (String text : List.of("Retrieved page", "Script failed\nWall time: 1.0 seconds\nOutput:\nactual failure")) {
            JsonArray records = new JsonArray();
            records.add(call("single-web", "text(await tools.web__run({search_query:[{q:'fixture'}]}));"));
            records.add(output("single-web", text));
            List<JsonObject> blocks = blocks(records);
            assertEquals(List.of("webSearch"), toolNames(blocks));
            assertTrue(results(blocks).get(0).contains(text.startsWith("Script failed") ? "actual failure" : text));
            assertEquals(text.startsWith("Script failed"), blocks.get(1).get("is_error").getAsBoolean());
        }
        JsonArray incomplete = new JsonArray();
        incomplete.add(call("unknown", "await tools.web__run({open:[{ref_id:'https://example.com'}]});"
                + "await tools.exec_command({cmd:'npm test'});"));
        incomplete.add(output("unknown", "shared output cannot prove both outcomes"));
        assertTrue(toolNames(blocks(incomplete)).contains("exec"));
    }

    private static JsonObject nativeImage(String id, String path) {
        JsonObject record = nativeCommand(id, "completed", 0);
        JsonObject item = record.getAsJsonObject("payload").getAsJsonObject("item");
        item.addProperty("type", "ImageView");
        item.addProperty("path", path);
        return record;
    }

    private static JsonObject nativeCommand(String id, String status, int exitCode) {
        JsonObject item = new JsonObject();
        item.addProperty("type", "CommandExecution");
        item.addProperty("id", id);
        item.addProperty("status", status);
        item.addProperty("exit_code", exitCode);
        item.addProperty("command", "npm test");
        item.addProperty("formatted_output", id + " output");
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "item_completed");
        payload.addProperty("thread_id", "root");
        payload.addProperty("turn_id", "own");
        payload.add("item", item);
        JsonObject event = new JsonObject();
        event.addProperty("type", "event_msg");
        event.add("payload", payload);
        return event;
    }

    private static JsonObject call(String id, String script) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call");
        payload.addProperty("call_id", id);
        payload.addProperty("name", "exec");
        payload.addProperty("input", script);
        JsonObject record = new JsonObject();
        record.addProperty("type", "response_item");
        record.add("payload", payload);
        return record;
    }

    private static JsonObject output(String id, String... texts) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call_output");
        payload.addProperty("call_id", id);
        JsonArray content = new JsonArray();
        for (String text : texts) {
            JsonObject block = new JsonObject();
            block.addProperty("type", "input_text");
            block.addProperty("text", text);
            content.add(block);
        }
        payload.add("output", content);
        JsonObject record = new JsonObject();
        record.addProperty("type", "response_item");
        record.add("payload", payload);
        return record;
    }

    private static String indexed(int index, String value) {
        return "{\"i\":" + index + ",\"status\":\"fulfilled\",\"value\":" + value + "}";
    }

    private static List<JsonObject> blocks(JsonArray records) {
        List<JsonObject> blocks = new ArrayList<>();
        for (JsonObject message : HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records)) {
            message.getAsJsonObject("raw").getAsJsonArray("content").forEach(block -> blocks.add(block.getAsJsonObject()));
        }
        return blocks;
    }

    private static List<String> toolNames(List<JsonObject> blocks) {
        return blocks.stream().filter(block -> "tool_use".equals(string(block, "type")))
                .map(block -> string(block, "name")).toList();
    }

    private static List<String> results(List<JsonObject> blocks) {
        return blocks.stream().filter(block -> "tool_result".equals(string(block, "type")))
                .map(block -> string(block, "content")).toList();
    }

    private static String string(JsonObject object, String key) {
        return HistoryMessageInjector.getStringProperty(object, key);
    }
}
