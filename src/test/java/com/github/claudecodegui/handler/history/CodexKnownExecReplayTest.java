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
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Replays the mixed wrappers reported by the user without executing their source. */
public class CodexKnownExecReplayTest {
    private static final String PATCH = "*** Begin Patch\n*** Add File: a.ts\n+created\n*** End Patch";

    @Test
    public void lifecycleTurnOwnsMcpReceiptsWhenModelMetadataUsesAnotherTurnId() {
        JsonArray records = new JsonArray();
        records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
        records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"native-turn\"}}"));
        JsonObject wrapper = call("mcp-wrapper", "text(await tools.mcp__web_fetch__web_get_metadata({url:'https://example.com'}));");
        wrapper.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough",
                JsonParser.parseString("{\"turn_id\":\"model-turn\"}"));
        records.add(wrapper);
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"native-turn",
                "item":{"type":"McpToolCall","id":"native-mcp","server":"web-fetch","tool":"web_get_metadata",
                "arguments":{"url":"https://example.com"},"status":"completed",
                "result":{"content":[{"type":"text","text":"Example Domain"}]}}}}
                """));
        records.add(output("mcp-wrapper", "Script completed"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("web_get_metadata"), toolNames(projected));
        assertEquals("Example Domain", projected.get(1).getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
        assertFalse(projected.get(1).get("is_error").getAsBoolean());
        assertFalse(toolNames(projected).contains("exec"));
    }

    /** Labelled map batches retain source order while native receipts prove each command's outcome. */
    @Test
    public void restoresLabelledMappedCommandsWithLiteralOverrides() {
        String script = "// @exec: {\"max_output_tokens\":18500}\n"
                + "const jobs=[['proposal A',{cmd:'sed -n 1,195p plan.md',workdir:'/old',max_output_tokens:7000}],"
                + "['proposal B',{cmd:'sed -n 196,390p plan.md'}],"
                + "['validation',{cmd:\"node <<'NODE'\\nconsole.log('checked')\\nNODE\"}]];"
                + "const rs=await Promise.allSettled(jobs.map(async ([label,args])=>"
                + "({label,...await tools.exec_command({...args,workdir:'/project',max_output_tokens:2000})})));"
                + "for(const r of rs)text(r.status==='fulfilled'?r.value:r.reason);";
        JsonArray records = new JsonArray();
        records.add(call("mapped", script));
        List<String> commands = List.of("sed -n 1,195p plan.md", "sed -n 196,390p plan.md", "node <<'NODE'\nconsole.log('checked')\nNODE");
        for (int index : List.of(2, 0, 1)) {
            JsonObject receipt = nativeCommand("mapped-" + index, index == 2 ? "failed" : "completed", index == 2 ? 1 : 0);
            JsonObject item = receipt.getAsJsonObject("payload").getAsJsonObject("item");
            item.addProperty("command", commands.get(index));
            item.addProperty("cwd", "/project");
            records.add(receipt);
        }
        records.add(output("mapped", "Script completed\nOutput:\n", "{\"label\":\"proposal A\",\"exit_code\":0}",
                "{\"label\":\"proposal B\",\"exit_code\":0}", "{\"label\":\"validation\",\"exit_code\":1}"));

        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash", "bash"), toolNames(projected));
        assertEquals(List.of("mapped-0 output", "mapped-1 output", "mapped-2 output"), results(projected));
        List<JsonObject> tools = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
        for (int index = 0; index < tools.size(); index++) {
            JsonObject input = tools.get(index).getAsJsonObject("input");
            assertEquals(commands.get(index), string(input, "command"));
            assertEquals("/project", string(input, "workdir"));
            assertEquals(2000, input.get("max_output_tokens").getAsInt());
            assertFalse("a wrapper label is not a recorded execution reason", input.has("description"));
        }
        assertTrue(projected.stream().anyMatch(block -> "mapped-2".equals(string(block, "tool_use_id")) && block.get("is_error").getAsBoolean()));
    }

    /** A mapped command batch must not leave its neighbouring patch or MCP call inside an exec card. */
    @Test
    public void restoresMappedCommandsBesidePatchesAndMcpCalls() {
        JsonArray records = new JsonArray();
        records.add(call("mapped-mixed", "text(await tools.apply_patch(" + new Gson().toJson(PATCH) + "));"
                + "const jobs=[['date examples',{cmd:'node dates.js'}],['module status',{cmd:'git status --short'}]];"
                + "const rs=await Promise.allSettled(jobs.map(async ([label,args])=>"
                + "({label,...await tools.exec_command({...args,workdir:'/project'})})));"
                + "for(const r of rs){if(r.status==='fulfilled'){text(r.value.label);text(r.value.output);text({exit_code:r.value.exit_code});}else text(r.reason);}"
                + "text(await tools.mcp__dbx__inspect({database:'fixture'}));"));
        JsonObject patch = nativePatch();
        patch.getAsJsonObject("payload").addProperty("turn_id", "own");
        records.add(patch);
        for (String command : List.of("git status --short", "node dates.js")) {
            JsonObject receipt = nativeCommand(command, "completed", 0);
            receipt.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", command);
            records.add(receipt);
        }
        records.add(JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"own",
                "item":{"type":"McpToolCall","id":"database","server":"dbx","tool":"inspect","status":"completed",
                "arguments":{"database":"fixture"},"result":{"content":[{"type":"text","text":"query result"}]}}}}
                """));
        records.add(output("mapped-mixed", "{}", "date examples", "date output", "{\"exit_code\":0}",
                "module status", "status output", "{\"exit_code\":0}", "query result"));

        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("file_change", "bash", "bash", "inspect"), toolNames(projected));
        assertTrue(results(projected).containsAll(List.of("node dates.js output", "git status --short output")));
        assertEquals(1, projected.stream().filter(block -> "native-patch".equals(string(block, "id"))).count());
    }

    /** Dynamic jobs, mutations, unknown outcomes and ambiguous commands must remain reviewable. */
    @Test
    public void keepsUnprovenMappedBatchesInsideTheirWrapper() {
        String declaration = "const jobs=[['first',{cmd:'npm test'}],['second',{cmd:'gradle test'}]];";
        String mapping = "const rs=await Promise.allSettled(jobs.map(async ([label,args])=>"
                + "({label,...await tools.exec_command({...args,workdir:'/project'})})));";
        for (String script : List.of(declaration + mapping,
                declaration + "jobs.reverse();" + mapping,
                declaration + "const alias=jobs;" + mapping,
                declaration.replace("'npm test'", "computedCommand") + mapping,
                declaration + mapping.replace("'/project'", "cwd"),
                declaration + mapping.replace("...args,workdir", "...args,...options,workdir"),
                declaration + mapping.replace("...await tools", "...await maybeTools"))) {
            JsonArray records = new JsonArray();
            records.add(call("unproven-mapped", script));
            records.add(output("unproven-mapped", "shared output"));
            assertTrue(script, toolNames(blocks(records)).contains("exec"));
        }
        JsonArray ambiguous = new JsonArray();
        ambiguous.add(call("same-mapped", declaration.replace("gradle test", "npm test") + mapping));
        ambiguous.add(nativeCommand("first", "completed", 0));
        ambiguous.add(nativeCommand("second", "failed", 1));
        ambiguous.add(output("same-mapped", "unindexed output"));
        assertTrue(toolNames(blocks(ambiguous)).contains("exec"));
    }

    /** History commands retain native actions so the shared renderer can match live row labels. */
    @Test
    public void preservesNativeCommandActionsAcrossWrappersAndDetachedReceipts() {
        List<String> commands = List.of("tail -n 20 /tmp/build.log", "ls -la src", "node scripts/verify-command-output.mjs");
        List<String> types = List.of("read", "list_files", "unknown");
        for (boolean wrapped : List.of(false, true)) {
            JsonArray records = new JsonArray();
            if (wrapped) {
                records.add(call("command-labels", String.join("", commands.stream()
                        .map(command -> "text(await tools.exec_command({cmd:" + new Gson().toJson(command) + "}));").toList())));
            }
            for (int index = 0; index < commands.size(); index++) {
                JsonObject receipt = nativeCommand("command-" + index, "completed", 0);
                JsonObject item = receipt.getAsJsonObject("payload").getAsJsonObject("item");
                item.addProperty("command", commands.get(index));
                JsonObject action = new JsonObject();
                action.addProperty("type", types.get(index));
                action.addProperty("cmd", commands.get(index));
                if (index < 2) {
                    action.addProperty("path", index == 0 ? "/tmp/build.log" : "src");
                }
                JsonArray actions = new JsonArray();
                actions.add(action);
                item.add("parsed_cmd", actions);
                if (index == 2) {
                    item.addProperty("summary", "Verify command output");
                    item.addProperty("approvalReason", "Inspect generated output");
                }
                records.add(receipt);
            }
            if (wrapped) {
                records.add(output("command-labels", "{\"exit_code\":0}", "{\"exit_code\":0}", "{\"exit_code\":0}"));
            }

            List<JsonObject> tools = blocks(records).stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
            assertEquals(3, tools.size());
            for (int index = 0; index < tools.size(); index++) {
                JsonObject input = tools.get(index).getAsJsonObject("input");
                if (index == 2) {
                    assertEquals("Verify command output", string(input, "description"));
                    assertEquals("Inspect generated output", string(input, "approvalReason"));
                } else {
                    assertFalse("only recorded summaries belong in descriptions", input.has("description"));
                }
                assertEquals(commands.get(index), string(input, "command"));
                assertEquals(types.get(index), string(input.getAsJsonArray("commandActions").get(0).getAsJsonObject(), "type"));
            }
            assertEquals("/tmp/build.log", string(tools.get(0).getAsJsonObject("input").getAsJsonArray("commandActions").get(0).getAsJsonObject(), "path"));
        }
    }

    /** Explicit directories disambiguate same-text commands whose completed results omit session ids. */
    @Test
    public void restoresFourCommandBatchWithSameCommandInDifferentDirectories() {
        JsonArray records = new JsonArray();
        records.add(call("project-checks", "const results = await Promise.allSettled(["
                + "tools.exec_command({cmd:'rg --files src docs',max_output_tokens:6500}),"
                + "tools.exec_command({cmd:'git status --short',workdir:'/project/webapp',max_output_tokens:1200}),"
                + "tools.exec_command({cmd:'git status --short',workdir:'/project/vue',max_output_tokens:1200}),"
                + "tools.exec_command({cmd:'rg -n annual src/router',workdir:'/project/vue',max_output_tokens:6500})]);"
                + "for (let i=0;i<results.length;i++) text({index:i,...results[i]});"));
        for (int index : List.of(2, 0, 3, 1)) {
            JsonObject receipt = nativeCommand("native-" + index, index == 3 ? "failed" : "completed", index == 3 ? 2 : 0);
            JsonObject item = receipt.getAsJsonObject("payload").getAsJsonObject("item");
            item.addProperty("command", index == 0 ? "rg --files src docs" : index == 3 ? "rg -n annual src/router" : "git status --short");
            item.addProperty("process_id", String.valueOf(100 + index));
            item.addProperty("cwd", "file:///project/" + (index == 1 ? "webapp" : index == 0 ? "" : "vue"));
            records.add(receipt);
        }
        records.add(output("project-checks", "Script completed\nOutput:\n",
                "{\"index\":0,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"files\"}}",
                "{\"index\":1,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"webapp status\"}}",
                "{\"index\":2,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"vue status\"}}",
                "{\"index\":3,\"status\":\"fulfilled\",\"value\":{\"exit_code\":2,\"output\":\"missing router\"}}"));

        List<JsonObject> projected = blocks(records);
        List<JsonObject> tools = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
        assertEquals(List.of("bash", "bash", "bash", "bash"), toolNames(projected));
        assertEquals(List.of("native-0", "native-1", "native-2", "native-3"), tools.stream().map(tool -> string(tool, "id")).toList());
        assertEquals("/project/webapp", string(tools.get(1).getAsJsonObject("input"), "workdir"));
        assertEquals("/project/vue", string(tools.get(2).getAsJsonObject("input"), "workdir"));
        assertEquals(List.of("native-0 output", "native-1 output", "native-2 output", "native-3 output"), results(projected));
    }

    /** Directory evidence must preserve an edit between two otherwise identical commands. */
    @Test
    public void keepsPatchAndDirectoryOwnedCommandsAsMixedToolCards() {
        JsonArray records = new JsonArray();
        records.add(call("mixed-directories", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test',workdir:'/project/webapp'}),"
                + "tools.apply_patch(" + new Gson().toJson(PATCH) + "),"
                + "tools.exec_command({cmd:'npm test',workdir:'/project/vue'})]);"
                + "for(let i=0;i<results.length;i++)text({index:i,...results[i]});"));
        records.add(nativePatch());
        for (int index : List.of(2, 0)) {
            JsonObject receipt = nativeCommand("command-" + index, "completed", 0);
            JsonObject payload = receipt.getAsJsonObject("payload");
            payload.addProperty("turn_id", "turn");
            payload.getAsJsonObject("item").addProperty("cwd", "/project/" + (index == 0 ? "webapp" : "vue"));
            records.add(receipt);
        }
        records.add(output("mixed-directories", indexed(0, "{\"exit_code\":0,\"output\":\"webapp\"}"),
                indexed(1, "{}"), indexed(2, "{\"exit_code\":0,\"output\":\"vue\"}")));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "file_change", "bash"), toolNames(projected));
        assertEquals(List.of("command-0 output", "saved", "command-2 output"), results(projected));
    }

    /** POSIX backslashes remain filename characters when directory evidence owns a command receipt. */
    @Test
    public void distinguishesPosixBackslashesFromDirectorySeparators() {
        JsonArray records = new JsonArray();
        records.add(call("posix-directories", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test',workdir:" + new Gson().toJson("/project/a\\b") + "}),"
                + "tools.exec_command({cmd:'npm test',workdir:'/project/a/b'})]);"
                + "results.forEach((r,i)=>text({index:i,...r}));"));
        JsonObject second = nativeCommand("nested-directory", "failed", 2);
        second.getAsJsonObject("payload").getAsJsonObject("item").addProperty("cwd", "file:///project/a/b");
        records.add(second);
        JsonObject first = nativeCommand("literal-backslash", "completed", 0);
        first.getAsJsonObject("payload").getAsJsonObject("item").addProperty("cwd", "file:///project/a%5Cb");
        records.add(first);
        records.add(output("posix-directories", indexed(0, "{\"exit_code\":0,\"output\":\"first passed\"}"),
                indexed(1, "{\"exit_code\":2,\"output\":\"second failed\"}")));

        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("literal-backslash", "nested-directory"), projected.stream()
                .filter(block -> "tool_use".equals(string(block, "type"))).map(block -> string(block, "id")).toList());
        assertEquals(List.of("literal-backslash output", "nested-directory output"), results(projected));
    }

    /** Windows separators and URI-encoded spaces identify the same recorded working directory. */
    @Test
    public void pairsWindowsDirectoriesWithTheirFileUris() {
        JsonArray records = new JsonArray();
        records.add(call("windows-directories", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test',workdir:" + new Gson().toJson("C:\\Project One\\webapp\\") + "}),"
                + "tools.exec_command({cmd:'npm test',workdir:'C:/Project One/vue'})]);"
                + "results.forEach((r,i)=>text({index:i,...r}));"));
        for (String directory : List.of("vue", "webapp")) {
            JsonObject receipt = nativeCommand(directory, "completed", 0);
            receipt.getAsJsonObject("payload").getAsJsonObject("item").addProperty("cwd", "file:///C:/Project%20One/" + directory);
            records.add(receipt);
        }
        records.add(output("windows-directories", indexed(0, "{\"exit_code\":0}"), indexed(1, "{\"exit_code\":0}")));

        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("webapp output", "vue output"), results(projected));
    }

    /** Completion-order output cannot lend a sibling's process id to a different source slot. */
    @Test
    public void pairsUnindexedBatchCommandsByIndependentDirectoryReceipts() {
        JsonArray records = new JsonArray();
        records.add(call("completion-order", "await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test',workdir:'/first'}).then(text),"
                + "tools.exec_command({cmd:'npm test',workdir:'/second'}).then(text)]);"));
        for (String directory : List.of("second", "first")) {
            JsonObject receipt = nativeCommand(directory, "completed", 0);
            JsonObject item = receipt.getAsJsonObject("payload").getAsJsonObject("item");
            item.addProperty("cwd", "/" + directory);
            item.addProperty("process_id", directory.equals("first") ? "11" : "22");
            records.add(receipt);
        }
        records.add(output("completion-order", "{\"session_id\":22,\"output\":\"second running\"}",
                "{\"session_id\":11,\"output\":\"first running\"}"));

        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("first", "second"), projected.stream()
                .filter(block -> "tool_use".equals(string(block, "type"))).map(block -> string(block, "id")).toList());
        assertEquals(List.of("first output", "second output"), results(projected));
    }

    /** A matching receipt directory is insufficient when another call may share that directory. */
    @Test
    public void keepsSharedOrUnknownDirectoryOwnersOpaque() {
        for (String siblingDirectory : List.of("/first", "", "../second")) {
            CodexKnownExecReplay replay = CodexKnownExecReplay.begin(call("uncertain-directories", "const results=await Promise.allSettled(["
                    + "tools.exec_command({cmd:'npm test',workdir:'/first'}),"
                    + "tools.exec_command({cmd:'npm test',workdir:" + new Gson().toJson(siblingDirectory) + "})]);"
                    + "results.forEach((r,i)=>text({index:i,...r}));"), null);
            for (String directory : List.of("first", "second")) {
                JsonObject receipt = nativeCommand(directory, "completed", 0);
                receipt.getAsJsonObject("payload").getAsJsonObject("item").addProperty("cwd", "/" + directory);
                replay.rememberNative(receipt);
            }

            assertNull(siblingDirectory, replay.project(output("uncertain-directories", indexed(0, "{\"exit_code\":0}"),
                    indexed(1, "{\"exit_code\":0}")), new java.util.LinkedHashMap<>()));
            assertTrue(siblingDirectory, replay.keepsOriginalWrapper());
        }
    }

    /** Identical commands in separate directories keep their process-owned results despite receipt reordering. */
    @Test
    public void pairsIdenticalBatchCommandsByTheirReturnedProcessIds() {
        JsonArray records = new JsonArray();
        records.add(call("parallel-checks", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test',workdir:'/first'}),tools.exec_command({cmd:'npm test',workdir:'/second'})]);"
                + "results.forEach((r,i)=>text({index:i,...r}));"));
        JsonObject second = nativeCommand("native-second", "failed", 2);
        second.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "22");
        records.add(second);
        JsonObject first = nativeCommand("native-first", "completed", 0);
        first.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
        records.add(first);
        records.add(output("parallel-checks", "{\"index\":0,\"status\":\"fulfilled\",\"value\":{\"session_id\":11,\"output\":\"first running\"}}",
                "{\"index\":1,\"status\":\"fulfilled\",\"value\":{\"session_id\":22,\"output\":\"second running\"}}"));
        List<JsonObject> projected = blocks(records);
        List<JsonObject> tools = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("native-first", "native-second"), tools.stream().map(tool -> string(tool, "id")).toList());
        assertEquals(List.of("/first", "/second"), tools.stream().map(tool -> string(tool.getAsJsonObject("input"), "workdir")).toList());
        assertEquals(List.of("native-first output", "native-second output"), results(projected));
        assertEquals(List.of(false, true), projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                .map(block -> block.get("is_error").getAsBoolean()).toList());
    }

    /** Without process identity, same-text receipts cannot prove which directory's command completed. */
    @Test
    public void keepsIdenticalBatchCommandsOpaqueWhenTheirReceiptsCannotBePaired() {
        for (boolean withResultProcessIds : List.of(false, true)) {
            var processes = new java.util.LinkedHashMap<String, CodexKnownExecReplay.Process>();
            CodexKnownExecReplay replay = CodexKnownExecReplay.begin(call("uncertain-identical", "const results=await Promise.allSettled(["
                    + "tools.exec_command({cmd:'npm test',workdir:'/first'}),tools.exec_command({cmd:'npm test',workdir:'/second'})]);"
                    + "results.forEach((r,i)=>text({index:i,...r}));"), null);
            replay.rememberNative(nativeCommand("native-second", "failed", 2));
            replay.rememberNative(nativeCommand("native-first", "completed", 0));
            String first = withResultProcessIds ? "{\"session_id\":11,\"output\":\"first running\"}" : "{\"exit_code\":0,\"output\":\"first passed\"}";
            String second = withResultProcessIds ? "{\"session_id\":22,\"output\":\"second running\"}" : "{\"exit_code\":2,\"output\":\"second failed\"}";
            assertNull(replay.project(output("uncertain-identical", "{\"index\":0,\"status\":\"fulfilled\",\"value\":" + first + "}",
                    "{\"index\":1,\"status\":\"fulfilled\",\"value\":" + second + "}"), processes));
            assertTrue(replay.keepsOriginalWrapper());
            assertTrue(processes.isEmpty());
        }
    }

    /** Pending input without a receipt must retain its wrapper and leave the tracked process alive. */
    @Test
    public void keepsPendingStdinObservableBeforeItsOutcomeArrives() {
        var processes = new java.util.LinkedHashMap<String, CodexKnownExecReplay.Process>();
        CodexKnownExecReplay started = CodexKnownExecReplay.begin(call("started", "text(await tools.exec_command({cmd:'interactive-command'}));"), null);
        started.project(output("started", "{\"session_id\":42,\"output\":\"waiting\"}"), processes);
        CodexKnownExecReplay input = CodexKnownExecReplay.begin(call("input", "text(await tools.write_stdin({session_id:42,chars:'yes\\n'}));"
                + "text(await tools.exec_command({cmd:'git status'}));"), null);
        assertNull(input.project(null, processes));
        assertTrue(input.keepsOriginalWrapper());
        assertEquals(1, processes.size());
    }

    /** Identical commands still have distinct native process identities and terminal results. */
    @Test
    public void matchesIdenticalRunningCommandsByNativeProcessId() {
        JsonArray records = new JsonArray();
        records.add(call("first-process", "text(await tools.exec_command({cmd:'npm test'}));"));
        records.add(output("first-process", "{\"session_id\":11,\"output\":\"first running\"}"));
        records.add(call("second-process", "text(await tools.exec_command({cmd:'npm test'}));"));
        records.add(output("second-process", "{\"session_id\":22,\"output\":\"second running\"}"));
        JsonObject second = nativeCommand("native-second", "completed", 0);
        second.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "22");
        records.add(second);
        records.add(call("finish-first", "text(await tools.write_stdin({session_id:11,chars:''}));"));
        records.add(output("finish-first", "{\"exit_code\":0,\"output\":\"first finished\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("native-second output", "first finished"), results(projected));
        assertEquals(List.of("second-process:command:0", "first-process:command:0"),
                projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                        .map(block -> string(block, "tool_use_id")).toList());
    }

    /** A native process id can close the original command even after another user turn starts. */
    @Test
    public void closesProcessOwnedCompletionsAcrossUserTurns() {
        for (boolean insideWrapper : List.of(false, true)) {
            JsonArray records = new JsonArray();
            JsonObject started = call("earlier-process", "text(await tools.exec_command({cmd:'npm test'}));");
            started.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough",
                    JsonParser.parseString("{\"turn_id\":\"earlier-turn\"}"));
            records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
            records.add(started);
            records.add(output("earlier-process", "{\"session_id\":11,\"output\":\"running\"}"));
            if (insideWrapper) {
                records.add(call("later-poll", "text(await tools.write_stdin({session_id:11,chars:'\\u0003'}));"
                        + "text(await tools.exec_command({cmd:'git status'}));"));
            }
            JsonObject completed = nativeCommand("native-earlier", "failed", 130);
            completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
            records.add(completed);
            if (insideWrapper) {
                records.add(output("later-poll", "{\"exit_code\":130,\"output\":\"interrupted\"}",
                        "{\"exit_code\":0,\"output\":\"status checked\"}"));
            }

            List<JsonObject> projected = blocks(records);

            assertEquals(insideWrapper ? List.of("bash", "bash") : List.of("bash"), toolNames(projected));
            assertEquals(1, projected.stream().filter(block -> "earlier-process:command:0".equals(string(block, "tool_use_id"))).count());
            assertTrue(results(projected).contains("native-earlier output"));
            assertFalse(toolNames(projected).contains("exec"));
        }
    }

    /** An owned background receipt keeps its original turn without invalidating the current wrapper. */
    @Test
    public void backgroundCompletionCannotBorrowTheCurrentWrappersTurn() {
        for (boolean explicitTurn : List.of(false, true)) {
            for (boolean pollsProcess : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
                JsonObject started = call("earlier-process", "text(await tools.exec_command({cmd:'npm test'}));");
                started.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough",
                        JsonParser.parseString("{\"turn_id\":\"earlier-turn\"}"));
                records.add(started);
                records.add(output("earlier-process", "{\"session_id\":11,\"output\":\"running\"}"));
                String poll = pollsProcess ? "text(await tools.write_stdin({session_id:11,chars:'\\u0003'}));" : "";
                JsonObject current = call("current-batch", poll + "text(await tools.exec_command({cmd:'git status'}));");
                if (explicitTurn) {
                    current.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough",
                            JsonParser.parseString("{\"turn_id\":\"current-turn\"}"));
                }
                records.add(current);
                JsonObject earlier = nativeCommand("native-earlier", "failed", 130);
                earlier.getAsJsonObject("payload").addProperty("turn_id", "earlier-turn");
                earlier.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
                records.add(earlier);
                JsonObject completed = nativeCommand("native-current", "completed", 0);
                completed.getAsJsonObject("payload").addProperty("turn_id", "current-turn");
                completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "git status");
                records.add(completed);
                if (pollsProcess) {
                    records.add(output("current-batch", "{\"exit_code\":130,\"output\":\"interrupted\"}",
                            "{\"exit_code\":0,\"output\":\"status checked\"}"));
                } else {
                    records.add(output("current-batch", "{\"exit_code\":0,\"output\":\"status checked\"}"));
                }

                List<JsonObject> projected = blocks(records);

                assertEquals(List.of("bash", "bash"), toolNames(projected));
                assertEquals(2, results(projected).size());
                assertTrue(results(projected).contains("native-earlier output"));
                assertTrue(results(projected).contains("native-current output"));
                for (JsonObject message : HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records)) {
                    JsonObject raw = message.getAsJsonObject("raw");
                    JsonObject block = raw.getAsJsonArray("content").get(0).getAsJsonObject();
                    String toolId = block.has("id") ? string(block, "id") : string(block, "tool_use_id");
                    assertEquals("earlier-process:command:0".equals(toolId) ? "earlier-turn" : "current-turn",
                            string(raw, "codexTurnId"));
                }
            }
        }
    }

    /** Reused numeric process ids in another thread must not close the original command. */
    @Test
    public void keepsForeignThreadCompletionsAwayFromTheTrackedProcess() {
        for (boolean insideWrapper : List.of(false, true)) {
            JsonObject owner = JsonParser.parseString("{\"codexThreadId\":\"root\",\"codexTurnId\":\"earlier-turn\"}").getAsJsonObject();
            var process = new CodexKnownExecReplay.Process("original-command", owner, "npm test");
            var processes = new java.util.LinkedHashMap<String, CodexKnownExecReplay.Process>();
            processes.put("11", process);
            JsonObject completed = nativeCommand("foreign-command", "completed", 0);
            completed.getAsJsonObject("payload").addProperty("thread_id", "another-thread");
            completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
            if (insideWrapper) {
                // Missing wrapper scope must not weaken the process's own recorded thread.
                CodexKnownExecReplay poll = CodexKnownExecReplay.begin(
                        call("poll", "text(await tools.write_stdin({session_id:11,chars:''}));"), null);
                poll.rememberNative(completed);
                assertNull(poll.project(output("poll", "{\"exit_code\":0,\"output\":\"foreign output\"}"), processes));
                assertTrue(poll.keepsOriginalWrapper());
            } else {
                List<JsonObject> messages = CodexKnownExecReplay.readNativeCommand(completed, processes);
                assertEquals(2, messages.size());
                assertEquals("foreign-command", messages.get(1).getAsJsonObject("raw").getAsJsonArray("content")
                        .get(0).getAsJsonObject().get("tool_use_id").getAsString());
            }
            assertEquals(process, processes.get("11"));
            assertEquals(1, processes.size());
        }
    }

    /** A new identical command cannot borrow an earlier process's receipt, regardless of call order. */
    @Test
    public void separatesInterruptedAndNewIdenticalCommandsInEitherOrder() {
        for (boolean stdinFirst : List.of(false, true)) {
            for (boolean withCurrentReceipt : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(call("earlier", "text(await tools.exec_command({cmd:'npm test'}));"));
                records.add(output("earlier", "{\"session_id\":11,\"output\":\"running\"}"));
                String stdin = "text(await tools.write_stdin({session_id:11,chars:'\\u0003'}));";
                String command = "text(await tools.exec_command({cmd:'npm test'}));";
                records.add(call("repeat", stdinFirst ? stdin + command : command + stdin));
                JsonObject stopped = nativeCommand("native-earlier", "failed", 130);
                stopped.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
                records.add(stopped);
                if (withCurrentReceipt) {
                    JsonObject current = nativeCommand("native-current", "completed", 0);
                    current.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "22");
                    records.add(current);
                }
                String stoppedResult = "{\"exit_code\":130,\"output\":\"interrupted\"}";
                String currentResult = "{\"exit_code\":0,\"output\":\"current passed\"}";
                records.add(output("repeat", stdinFirst ? stoppedResult : currentResult, stdinFirst ? currentResult : stoppedResult));
                List<JsonObject> projected = blocks(records);
                assertEquals(List.of("bash", "bash"), toolNames(projected));
                String currentToolId = withCurrentReceipt ? "native-current" : "repeat:command:" + (stdinFirst ? 1 : 0);
                assertEquals(stdinFirst ? List.of("earlier:command:0", currentToolId) : List.of(currentToolId, "earlier:command:0"),
                        projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                                .map(block -> string(block, "tool_use_id")).toList());
                assertEquals(stdinFirst ? List.of(true, false) : List.of(false, true),
                        projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                                .map(block -> block.get("is_error").getAsBoolean()).toList());
                assertTrue(results(projected).contains("native-earlier output"));
                assertTrue(results(projected).contains(withCurrentReceipt ? "native-current output" : "current passed"));
            }
        }
    }

    /** Ctrl+C and its native receipt must finish the original command without hiding later checks. */
    @Test
    public void restoresInterruptedProcessAndFollowingCommandsWithoutAnExecCard() {
        for (boolean withProcessId : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(call("download", "text(await tools.exec_command({cmd:'npx playwright install chromium'}));"));
            records.add(output("download", "{\"session_id\":69446,\"output\":\"downloading\"}"));
            records.add(call("interrupt-and-check", "text(await tools.write_stdin({session_id:69446,chars:'\\u0003'}));"
                    + "text(await tools.exec_command({cmd:'npx playwright test'}));"
                    + "text(await tools.exec_command({cmd:'java JUnitCore'}));"));
            JsonObject stopped = nativeCommand("native-download", "failed", 130);
            stopped.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "npx playwright install chromium");
            if (withProcessId) {
                stopped.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "69446");
            }
            records.add(stopped);
            records.add(output("interrupt-and-check", "{\"exit_code\":130,\"output\":\"interrupted\"}",
                    "{\"session_id\":49616,\"output\":\"browser checks running\"}", "{\"session_id\":30408,\"output\":\"java checks running\"}"));
            JsonObject browser = nativeCommand("native-browser", "completed", 0);
            browser.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "npx playwright test");
            records.add(browser);
            JsonObject java = nativeCommand("native-java", "completed", 0);
            java.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "java JUnitCore");
            records.add(java);
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("bash", "bash", "bash"), toolNames(projected));
            assertEquals(List.of("native-download output", "native-browser output", "native-java output"), results(projected));
            assertEquals(List.of("download:command:0", "interrupt-and-check:command:1", "interrupt-and-check:command:2"),
                    projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                            .map(block -> string(block, "tool_use_id")).toList());
            assertEquals(List.of(true, false, false), projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                    .map(block -> block.get("is_error").getAsBoolean()).toList());
        }
    }

    /** A legacy receipt cannot identify one process when another command has the same text. */
    @Test
    public void preservesStdinWhenLegacyNativeCommandOwnershipIsAmbiguous() {
        for (boolean duplicateInCurrentWrapper : List.of(false, true)) {
            var processes = new java.util.LinkedHashMap<String, CodexKnownExecReplay.Process>();
            CodexKnownExecReplay first = CodexKnownExecReplay.begin(call("first", "text(await tools.exec_command({cmd:'npm test'}));"), null);
            first.project(output("first", "{\"session_id\":11,\"output\":\"running\"}"), processes);
            if (!duplicateInCurrentWrapper) {
                CodexKnownExecReplay second = CodexKnownExecReplay.begin(call("second", "text(await tools.exec_command({cmd:'npm test'}));"), null);
                second.project(output("second", "{\"session_id\":22,\"output\":\"running\"}"), processes);
            }
            String followingCommand = duplicateInCurrentWrapper ? "npm test" : "git status";
            for (boolean stdinFirst : List.of(false, true)) {
                String stdin = "text(await tools.write_stdin({session_id:11,chars:'\\u0003'}));";
                String command = "text(await tools.exec_command({cmd:'" + followingCommand + "'}));";
                CodexKnownExecReplay input = CodexKnownExecReplay.begin(call("ambiguous", stdinFirst ? stdin + command : command + stdin), null);
                input.rememberNative(nativeCommand("unidentified-process", "failed", 130));
                String stoppedResult = "{\"exit_code\":130,\"output\":\"interrupted\"}";
                String nextResult = "{\"exit_code\":0,\"output\":\"next finished\"}";
                assertNull(input.project(output("ambiguous", stdinFirst ? stoppedResult : nextResult, stdinFirst ? nextResult : stoppedResult), processes));
                assertTrue(input.keepsOriginalWrapper());
                assertEquals(duplicateInCurrentWrapper ? 1 : 2, processes.size());
            }
        }
    }

    /** Literal stdin can keep a process running while sibling commands complete independently. */
    @Test
    public void associatesNonEmptyStdinWithItsOriginalProcess() {
        JsonArray records = new JsonArray();
        records.add(call("interactive", "text(await tools.exec_command({cmd:'interactive-command'}));"));
        records.add(output("interactive", "{\"session_id\":42,\"output\":\"waiting for input\"}"));
        records.add(call("answer", "text(await tools.write_stdin({session_id:42,chars:'yes\\n'}));"
                + "text(await tools.exec_command({cmd:'git status'}));"));
        records.add(output("answer", "{\"session_id\":42,\"output\":\"accepted input\"}", "{\"exit_code\":0,\"output\":\"status checked\"}"));
        records.add(call("finish", "text(await tools.write_stdin({session_id:42,chars:''}));"));
        records.add(output("finish", "{\"exit_code\":0,\"output\":\"interactive finished\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("status checked", "interactive finished"), results(projected));
        assertEquals("interactive:command:0", string(projected.get(projected.size() - 1), "tool_use_id"));
    }

    /** A native process id proves the interrupted command even when its original start is absent. */
    @Test
    public void restoresInterruptedCommandFromItsNativeProcessIdentity() {
        JsonArray records = new JsonArray();
        records.add(call("interrupt", "text(await tools.write_stdin({session_id:69446,chars:'\\u0003'}));"
                + "text(await tools.exec_command({cmd:'git status'}));"));
        JsonObject stopped = nativeCommand("native-download", "failed", 130);
        stopped.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "npx playwright install chromium");
        stopped.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "69446");
        records.add(stopped);
        records.add(output("interrupt", "{\"exit_code\":130,\"output\":\"interrupted\"}", "{\"exit_code\":0,\"output\":\"status checked\"}"));
        assertEquals(List.of("bash", "bash"), toolNames(blocks(records)));
        assertEquals(List.of("native-download output", "status checked"), results(blocks(records)));
    }

    /** An unowned stdin outcome cannot hide an unknown command behind a recognized sibling. */
    @Test
    public void retainsNonEmptyStdinWhenTheTargetProcessCannotBeRestored() {
        JsonArray records = new JsonArray();
        records.add(call("unknown-input", "text(await tools.write_stdin({session_id:999,chars:'exit\\n'}));"
                + "text(await tools.exec_command({cmd:'git status'}));"));
        records.add(output("unknown-input", "{\"exit_code\":0,\"output\":\"process stopped\"}", "{\"exit_code\":0,\"output\":\"status checked\"}"));
        assertTrue(toolNames(blocks(records)).contains("exec"));
    }

    /** Native completions and indexed wrapper receipts must restore each command only once. */
    @Test
    public void restoresIndexNamedBatchAndLateCompletionWithoutDuplicateCards() {
        JsonArray records = new JsonArray();
        records.add(call("review-batch", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'git diff -- bridge'}),tools.exec_command({cmd:'git diff -- java'}),"
                + "tools.exec_command({cmd:'node --test'})]);"
                + "for(let i=0;i<results.length;i++)text({index:i,...results[i]});"));
        JsonObject first = nativeCommand("native-bridge-diff", "completed", 0);
        first.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "git diff -- bridge");
        records.add(first);
        JsonObject second = nativeCommand("native-java-diff", "completed", 0);
        second.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "git diff -- java");
        records.add(second);
        records.add(output("review-batch", "{\"index\":0,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"bridge diff\"}}",
                "{\"index\":1,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"java diff\"}}",
                "{\"index\":2,\"status\":\"fulfilled\",\"value\":{\"session_id\":91831,\"output\":\"tests running\"}}"));
        JsonObject completed = nativeCommand("native-tests", "completed", 0);
        completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "node --test");
        records.add(completed);
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash", "bash"), toolNames(projected));
        assertEquals(List.of("native-bridge-diff output", "native-java-diff output", "native-tests output"), results(projected));
        assertEquals("review-batch:command:2", string(projected.get(projected.size() - 1), "tool_use_id"));
    }

    /** Conflicting slot labels cannot assign an outcome to a different command. */
    @Test
    public void keepsConflictingIndexAliasesReviewable() {
        JsonArray records = new JsonArray();
        records.add(call("conflicting-index", "const results=await Promise.allSettled(["
                + "tools.exec_command({cmd:'npm test'}),tools.exec_command({cmd:'git status'})]);"
                + "results.forEach((r,i)=>text({i,...r}));"));
        records.add(output("conflicting-index", "{\"i\":0,\"index\":1,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"ambiguous\"}}",
                "{\"i\":1,\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"second\"}}"));
        assertTrue(toolNames(blocks(records)).contains("exec"));
    }

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

    /** Reusing a completed process id for another literal must not duplicate the new command. */
    @Test
    public void completedProcessIdCanBelongToANewCommand() {
        JsonArray records = new JsonArray();
        records.add(call("earlier", "text(await tools.exec_command({cmd:'npm test'}));"));
        records.add(output("earlier", "{\"session_id\":11,\"output\":\"running\"}"));
        records.add(call("finished", "text(await tools.write_stdin({session_id:11,chars:''}));"));
        records.add(output("finished", "{\"exit_code\":0,\"output\":\"old command stopped\"}"));
        records.add(call("current", "text(await tools.exec_command({cmd:'git status'}));"));
        JsonObject completed = nativeCommand("native-current", "completed", 0);
        completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
        completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("command", "git status");
        records.add(completed);
        records.add(output("current", "{\"exit_code\":0,\"output\":\"new command stopped\"}"));

        List<JsonObject> projected = blocks(records);

        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("old command stopped", "native-current output"), results(projected));
        assertEquals("native-current", string(projected.get(projected.size() - 1), "tool_use_id"));
    }

    /** Optional completed owners must stay bounded without evicting a newly started command. */
    @Test
    public void completedOwnersMakeRoomForRunningCommands() {
        var processes = new java.util.LinkedHashMap<String, CodexKnownExecReplay.Process>();
        for (int index = 0; index < 256; index++) {
            processes.put("completed-" + index,
                    new CodexKnownExecReplay.Process("tool-" + index, new JsonObject(), "old command", true));
        }
        CodexKnownExecReplay replay = CodexKnownExecReplay.begin(
                call("new-command", "text(await tools.exec_command({cmd:'npm test'}));"), null);

        replay.project(output("new-command", "{\"session_id\":11,\"output\":\"running\"}"), processes);

        assertEquals(256, processes.size());
        assertTrue(processes.containsKey("11"));
        assertFalse(processes.containsKey("completed-0"));
        assertFalse(processes.get("11").completed());
    }

    /** Retained completion ownership cannot hide fresh input directed at an already closed process. */
    @Test
    public void keepsInputToACompletedProcessObservable() {
        for (boolean withNativeReceipt : List.of(false, true)) {
            var processes = new java.util.LinkedHashMap<String, CodexKnownExecReplay.Process>();
            CodexKnownExecReplay started = CodexKnownExecReplay.begin(
                    call("started", "text(await tools.exec_command({cmd:'npm test'}));"), null);
            started.project(output("started", "{\"session_id\":11,\"output\":\"running\"}"), processes);
            CodexKnownExecReplay finished = CodexKnownExecReplay.begin(
                    call("finished", "text(await tools.write_stdin({session_id:11,chars:''}));"), null);
            finished.project(output("finished", "{\"exit_code\":0,\"output\":\"stopped\"}"), processes);
            CodexKnownExecReplay input = CodexKnownExecReplay.begin(
                    call("input", "text(await tools.write_stdin({session_id:11,chars:'yes\\n'}));"), null);
            if (withNativeReceipt) {
                JsonObject completed = nativeCommand("native-started", "completed", 0);
                completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
                input.rememberNative(completed);
            }

            assertNull(input.project(output("input", "{\"exit_code\":0,\"output\":\"already stopped\"}"), processes));
            assertTrue(input.keepsOriginalWrapper());
            assertTrue(processes.get("11").completed());
        }
    }

    /** Repeated terminal polls cannot replace the first outcome while its native receipt is delayed. */
    @Test
    public void repeatedTerminalPollsKeepOneOutcomeBeforeTheNativeReceipt() {
        JsonArray records = new JsonArray();
        records.add(call("started", "text(await tools.exec_command({cmd:'npm test'}));"));
        records.add(output("started", "{\"session_id\":11,\"output\":\"running\"}"));
        for (String id : List.of("first-poll", "repeated-poll")) {
            records.add(call(id, "text(await tools.write_stdin({session_id:11,chars:''}));"));
            records.add(output(id, "{\"exit_code\":0,\"output\":\"stopped\"}"));
        }

        assertEquals(List.of("bash"), toolNames(blocks(records)));
        assertEquals(List.of("stopped"), results(blocks(records)));
    }

    /** A terminal stdin reply can beat its native completion without creating a second command card. */
    @Test
    public void nativeCompletionKeepsTheCommandAlreadyClosedByStdin() {
        for (String chars : List.of("", "\\u0003")) {
            JsonArray records = new JsonArray();
            records.add(call("started", "text(await tools.exec_command({cmd:'npm test'}));"));
            records.add(output("started", "{\"session_id\":11,\"output\":\"running\"}"));
            records.add(call("finish", "text(await tools.write_stdin({session_id:11,chars:'" + chars + "'}));"));
            records.add(output("finish", "{\"exit_code\":130,\"output\":\"stopped by stdin\"}"));
            JsonObject completed = nativeCommand("native-started", "failed", 130);
            completed.getAsJsonObject("payload").getAsJsonObject("item").addProperty("process_id", "11");
            records.add(completed);
            records.add(call("poll-again", "text(await tools.write_stdin({session_id:11,chars:''}));"));
            records.add(output("poll-again", "{\"exit_code\":130,\"output\":\"already stopped\"}"));

            List<JsonObject> projected = blocks(records);

            assertEquals(List.of("bash"), toolNames(projected));
            assertTrue(projected.stream().filter(block -> "tool_result".equals(string(block, "type")))
                    .allMatch(block -> "started:command:0".equals(string(block, "tool_use_id"))));
            assertEquals("native-started output", results(projected).get(results(projected).size() - 1));
        }
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

    /** Loop labels keep polling attached to its original command in either Promise array position. */
    @Test
    public void restoresLoopLabeledCommandAndPollReceiptsInEitherOrder() {
        for (boolean pollFirst : List.of(false, true)) {
            for (boolean terminal : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(call("previous", "text(await tools.exec_command({cmd:'gradle test'}));"));
                records.add(output("previous", "{\"session_id\":21009,\"output\":\"building\"}"));
                String poll = "tools.write_stdin({session_id:21009,chars:\"\",max_output_tokens:1000,yield_time_ms:1000})";
                String command = "tools.exec_command({cmd:\"git diff HEAD --check && rg -n 'reject\\\\(' src\","
                        + "workdir:'/project/webapp',max_output_tokens:4500})";
                records.add(call("loop-labeled", "const results=await Promise.allSettled(["
                        + (pollFirst ? poll + "," + command : command + "," + poll)
                        + "]);for(let i=0;i<results.length;i++){text(\"Result \"+i);const r=results[i];"
                        + "text(r.status===\"fulfilled\"?r.value:r.reason);}"));
                String pollResult = terminal ? "{\"exit_code\":0,\"output\":\"build passed\"}"
                        : "{\"session_id\":21009,\"output\":\"still building\"}";
                String commandResult = "{\"exit_code\":2,\"output\":\"check failed\"}";
                records.add(output("loop-labeled", "Script completed\nOutput:\n", "Result 0", pollFirst ? pollResult : commandResult,
                        "Result 1", pollFirst ? commandResult : pollResult));
                List<JsonObject> projected = blocks(records);
                assertEquals(List.of("bash", "bash"), toolNames(projected));
                assertEquals(pollFirst && terminal ? List.of("build passed", "check failed")
                        : terminal ? List.of("check failed", "build passed") : List.of("check failed"), results(projected));
                assertEquals(terminal ? 1 : 0, projected.stream()
                        .filter(block -> "previous:command:0".equals(string(block, "tool_use_id")) && !block.get("is_error").getAsBoolean()).count());
                if (!terminal) {
                    records.add(call("finish", "text(await tools.write_stdin({session_id:21009,chars:''}));"));
                    records.add(output("finish", "{\"exit_code\":0,\"output\":\"build passed\"}"));
                    projected = blocks(records);
                    assertEquals(List.of("bash", "bash"), toolNames(projected));
                    assertEquals(List.of("check failed", "build passed"), results(projected));
                }
                assertEquals(1, projected.stream().filter(block -> block.has("is_error") && block.get("is_error").getAsBoolean()).count());
            }
        }
    }

    /** Explicit loop labels preserve command slots even without native receipts or distinct command text. */
    @Test
    public void restoresLoopLabeledCommandsAcrossSupportedLabelSyntax() {
        for (String label : List.of("'Result '+slot", "\"Result \"+slot", "`Result ${slot}`")) {
            JsonArray records = new JsonArray();
            records.add(call("loop-slots", "let batch = await Promise.allSettled(["
                    + "tools.exec_command({cmd:'git status --short',workdir:'/project/webapp'}),"
                    + "tools.exec_command({cmd:'git status --short',workdir:'/project/vue'})]);"
                    + "for (let slot = 0; slot < batch.length; ++slot) { text(" + label + ");"
                    + "const receipt = batch[slot]; text(receipt.status === 'fulfilled' ? receipt.value : receipt.reason); }"));
            records.add(output("loop-slots", "Result 1", "{\"exit_code\":1,\"output\":\"vue failed\"}",
                    "Result 0", "{\"exit_code\":0,\"output\":\"webapp clean\"}"));
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("bash", "bash"), toolNames(projected));
            assertEquals(List.of("webapp clean", "vue failed"), results(projected));
            assertEquals(List.of(false, true), projected.stream().filter(block -> block.has("is_error"))
                    .map(block -> block.get("is_error").getAsBoolean()).toList());
        }
    }

    /** Whole settled receipts printed by a loop keep rejection independent from sibling command success. */
    @Test
    public void restoresLoopLabeledWholeSettledReceipts() {
        JsonArray records = new JsonArray();
        records.add(call("whole-loop", "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "tools.exec_command({cmd:'git status'})]);"
                + "for(let i=0;i<results.length;i++){text('Result '+i);const r=results[i];text(r);}"));
        records.add(output("whole-loop", "Result 0", "{\"status\":\"fulfilled\",\"value\":{\"exit_code\":0,\"output\":\"passed\"}}",
                "Result 1", "{\"status\":\"rejected\",\"reason\":\"command unavailable\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "bash"), toolNames(projected));
        assertEquals(List.of("passed", "command unavailable"), results(projected));
        assertFalse(projected.get(1).get("is_error").getAsBoolean());
        assertTrue(projected.get(3).get("is_error").getAsBoolean());
    }

    /** A label cannot lend its index to an unrelated result variable or a different array slot. */
    @Test
    public void keepsUnprovenLoopResultOwnershipInTheWrapper() {
        for (String printer : List.of(
                "for(let i=0;i<results.length;i++){text('Result '+i);const r=results[0];text(r.value);}",
                "for(let i=0;i<results.length;i++){text('Result '+i);const r=other[i];text(r.value);}",
                "for(let i=0;i<results.length;i++){text('Result '+i);const r=results[i];text(other.value);}",
                "for(let i=0;i<results.length;i++){const note=\"text('Result '+i);const r=results[i];text(r.value);\";text(other.value);}")) {
            JsonArray records = new JsonArray();
            records.add(call("unproven-loop", "const results=await Promise.allSettled(["
                    + "tools.write_stdin({session_id:21009,chars:''}),tools.exec_command({cmd:'npm test'})]);" + printer));
            records.add(output("unproven-loop", "Result 0", "{\"exit_code\":0,\"output\":\"poll passed\"}",
                    "Result 1", "{\"exit_code\":0,\"output\":\"tests passed\"}"));
            assertTrue(toolNames(blocks(records)).contains("exec"));
        }
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

    /** Detached native commands retain arguments and both output streams without a generated summary. */
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
        assertFalse(projected.get(0).getAsJsonObject("input").has("description"));
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

    /** Code Mode catalog lookups keep the two real MCP cards instead of duplicating their exec wrappers. */
    @Test
    public void catalogSelectedMcpWrappersReplayEachNativeResultOnce() {
        JsonArray records = catalogMcpScope();
        List<String> names = List.of("ccqa_get_success", "ccqa_get_expected_error");
        for (int index = 0; index < names.size(); index++) {
            String name = names.get(index);
            String callId = "catalog-" + index;
            records.add(call(callId, catalogMcpScript(name)));
            records.add(nativeCatalogMcp("native-" + index, name, index == 0 ? "completed" : "failed"));
            records.add(output(callId, "Script completed"));
        }
        List<JsonObject> projected = blocks(records);
        assertEquals(names, toolNames(projected));
        List<JsonObject> tools = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
        List<JsonObject> results = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))).toList();
        assertEquals(List.of("native-0", "native-1"), tools.stream().map(tool -> string(tool, "id")).toList());
        assertEquals(List.of("native-0", "native-1"), results.stream().map(result -> string(result, "tool_use_id")).toList());
        assertEquals(List.of(false, true), results.stream().map(result -> result.get("is_error").getAsBoolean()).toList());
        assertEquals("CCQA_MCP_SUCCESS", results.get(0).getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("CCQA_MCP_EXPECTED_ERROR", results.get(1).getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
    }

    /** Renamed bindings and nonempty literal arguments still require an exact native MCP match. */
    @Test
    public void catalogSelectedMcpWrappersPreserveLiteralArguments() {
        JsonArray records = catalogMcpScope();
        records.add(call("literal-catalog", "\nconst selected = ALL_TOOLS.find(candidate => /(?:^|__)inspect$/.test(candidate.name)"
                + " && candidate.name.includes('test_server'));\nconst reply = await tools[selected.name]("
                + "{path:'example.txt',nested:{enabled:true},entries:[1,'two']});\ntext(reply)\n"));
        JsonObject event = nativeCatalogMcp("native-literal", "inspect", "completed");
        JsonObject item = event.getAsJsonObject("payload").getAsJsonObject("item");
        item.addProperty("server", "test_server");
        JsonObject arguments = JsonParser.parseString("{\"path\":\"example.txt\",\"nested\":{\"enabled\":true},\"entries\":[1,\"two\"]}").getAsJsonObject();
        item.add("arguments", arguments);
        records.add(event);
        records.add(output("literal-catalog", "Script completed"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("inspect"), toolNames(projected));
        assertEquals("test_server", string(projected.get(0).getAsJsonObject("input"), "server"));
        assertEquals(arguments, projected.get(0).getAsJsonObject("input").getAsJsonObject("arguments"));
        assertEquals("native-literal", string(projected.get(1), "tool_use_id"));
    }

    /** The fresh owned rollout selects by endsWith and prints only text content blocks. */
    @Test
    public void catalogSelectedMcpWrappersReplayTextContentLoopsOnce() {
        JsonArray records = catalogMcpScope();
        List<String> names = List.of("ccqa_get_success", "ccqa_get_expected_error");
        for (int index = 0; index < names.size(); index++) {
            String name = names.get(index);
            String callId = "content-catalog-" + index;
            records.add(call(callId, catalogMcpTextContentScript(name)));
            records.add(nativeCatalogMcp("native-content-" + index, name, index == 0 ? "completed" : "failed"));
            records.add(output(callId, "Script completed"));
        }
        List<JsonObject> projected = blocks(records);
        assertEquals(names, toolNames(projected));
        List<JsonObject> tools = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
        List<JsonObject> results = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))).toList();
        assertEquals(List.of("native-content-0", "native-content-1"), tools.stream().map(tool -> string(tool, "id")).toList());
        assertEquals(List.of("native-content-0", "native-content-1"), results.stream().map(result -> string(result, "tool_use_id")).toList());
        assertEquals(List.of(false, true), results.stream().map(result -> result.get("is_error").getAsBoolean()).toList());
    }

    /** Both exact selectors permit the formatter, including safe block-local binding reuse. */
    @Test
    public void catalogSelectedMcpWrappersAcceptEquivalentTextFormatters() {
        String script = catalogMcpTextContentScript("ccqa_get_success");
        String loop = "for (const c of r.content ?? []) { if (c.type === \"text\") text(c.text); }";
        List<String> scripts = new ArrayList<>(List.of(script.replace(loop, "text(r);"),
                catalogMcpScript("ccqa_get_success").replace("text(r);", loop),
                script.replace("const t =", "const selected =").replace("tools[t.name]", "tools[selected.name]")
                        .replace("const r =", "const reply =").replace("r.content", "reply.content").replace('"', '\'')));
        for (String binding : List.of("t", "tools", "ALL_TOOLS")) {
            scripts.add(script.replace("const c of", "const " + binding + " of")
                    .replace("c.type", binding + ".type").replace("c.text", binding + ".text"));
        }
        for (String valid : scripts) {
            JsonArray records = catalogMcpScope();
            records.add(call("content-formatter", valid));
            records.add(nativeCatalogMcp("native-content", "ccqa_get_success", "completed"));
            records.add(output("content-formatter", "Script completed", "CCQA_MCP_SUCCESS"));
            assertEquals(valid, List.of("ccqa_get_success"), toolNames(blocks(records)));
        }
    }

    /** Complete matching excludes changed predicates, dynamic inputs, extra work and unsafe loop bindings. */
    @Test
    public void catalogSelectedMcpWrappersRejectChangedTextFormatters() {
        String script = catalogMcpTextContentScript("ccqa_get_success");
        List<String> invalid = new ArrayList<>(List.of(script + "text('extra');", "text('extra');" + script,
                script.replace(".endsWith(", ".includes("), script.replace("x.name.includes", "other.name.includes"),
                script.replace("({})", "({value: getValue()})"), script.replace("r.content", "other.content"),
                script.replace("c.type ===", "c.type !=="), script.replace("text(c.text)", "text(c.other)"),
                script.replace("text(c.text)", "text(other.text)"), script.replace("text(c.text)", "text(c.text); doWork()")));
        for (String binding : List.of("text", "r")) {
            invalid.add(script.replace("const c of", "const " + binding + " of")
                    .replace("c.type", binding + ".type").replace("c.text", binding + ".text"));
        }
        for (String unknown : invalid) {
            assertFalse(unknown, CodexKnownExecReplay.begin(call("invalid-content", unknown), "root", "native-turn").hasStaticActions());
            JsonArray records = catalogMcpScope();
            records.add(call("invalid-content", unknown));
            records.add(nativeCatalogMcp("native-content", "ccqa_get_success", "completed"));
            records.add(output("invalid-content", "Script completed", "original output"));
            assertTrue(unknown, toolNames(blocks(records)).contains("exec"));
            assertTrue(unknown, results(blocks(records)).stream().anyMatch(result -> result != null && result.contains("original output")));
        }
    }

    /** Neither native status nor isError can explain a later wrapper TypeError. */
    @Test
    public void catalogSelectedMcpWrappersRetainExplicitOuterFailures() {
        for (String script : List.of(catalogMcpScript("ccqa_get_success"), catalogMcpTextContentScript("ccqa_get_success"),
                "text(await tools.mcp__ccqa_acceptance__ccqa_get_success({}));")) {
            for (String status : List.of("completed", "failed")) {
                for (boolean isError : List.of(false, true)) {
                    for (String header : List.of("Script failed", "Script error: TypeError")) {
                        JsonArray records = catalogMcpScope();
                        records.add(call("outer-failure", script));
                        JsonObject nativeCall = nativeCatalogMcp("native-outcome", "ccqa_get_success", status);
                        nativeCall.getAsJsonObject("payload").getAsJsonObject("item").getAsJsonObject("result").addProperty("isError", isError);
                        records.add(nativeCall);
                        records.add(output("outer-failure", "  " + header + "\nOutput:\nTypeError: content is not iterable"));
                        List<JsonObject> projected = blocks(records);
                        assertEquals(List.of("exec", "ccqa_get_success"), toolNames(projected));
                        JsonObject exec = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))
                                && "exec".equals(string(block, "name"))).findFirst().orElseThrow();
                        JsonObject result = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))
                                && string(exec, "id").equals(string(block, "tool_use_id"))).findFirst().orElseThrow();
                        assertTrue(result.get("is_error").getAsBoolean());
                        assertTrue(string(result, "content").contains("TypeError: content is not iterable"));
                    }
                }
            }
        }
    }

    /** Completed outer headers ignore native status, nested isError and error-like MCP body text. */
    @Test
    public void catalogSelectedMcpWrappersKeepNativeAndOuterOutcomesSeparate() {
        for (String status : List.of("completed", "failed")) {
            JsonArray records = catalogMcpScope();
            records.add(call("native-error", catalogMcpTextContentScript("ccqa_get_expected_error")));
            JsonObject nativeCall = nativeCatalogMcp("native-error", "ccqa_get_expected_error", status);
            nativeCall.getAsJsonObject("payload").getAsJsonObject("item").getAsJsonObject("result").addProperty("isError", true);
            records.add(nativeCall);
            records.add(output("native-error", "Script completed\nOutput:\nScript failed", "{\"isError\":true,\"content\":\"Script failed\"}"));
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("ccqa_get_expected_error"), toolNames(projected));
            assertTrue(projected.get(1).get("is_error").getAsBoolean());
        }
    }

    /** The PyCharm owned rollout contains two sequential literal MCP calls in the same exec. */
    @Test
    public void sequentialLiteralMcpWrappersReplayEachNativeResultOnce() {
        JsonArray records = catalogMcpScope();
        JsonObject wrapper = call("literal-sequence", "text(await tools.mcp__ccqa_acceptance__ccqa_get_success({}));\n"
                + "text(await tools.mcp__ccqa_acceptance__ccqa_get_expected_error({}));\n");
        wrapper.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough", JsonParser.parseString("{\"turn_id\":\"model-turn\"}"));
        records.add(wrapper);
        records.add(nativeCatalogMcp("native-literal-success", "ccqa_get_success", "completed"));
        records.add(JsonParser.parseString("{\"type\":\"token_usage_record\",\"payload\":{\"turn_id\":\"native-turn\"}}"));
        records.add(nativeCatalogMcp("native-literal-error", "ccqa_get_expected_error", "failed"));
        records.add(output("literal-sequence", "Script completed", "{\"content\":[{\"type\":\"text\",\"text\":\"CCQA_MCP_SUCCESS\"}],\"isError\":false}",
                "{\"content\":[{\"type\":\"text\",\"text\":\"CCQA_MCP_EXPECTED_ERROR\"}],\"isError\":true}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("ccqa_get_success", "ccqa_get_expected_error"), toolNames(projected));
        List<JsonObject> tools = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
        List<JsonObject> results = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))).toList();
        assertEquals(List.of("native-literal-success", "native-literal-error"), tools.stream().map(tool -> string(tool, "id")).toList());
        assertEquals(List.of("native-literal-success", "native-literal-error"), results.stream().map(result -> string(result, "tool_use_id")).toList());
        assertEquals(List.of(false, true), results.stream().map(result -> result.get("is_error").getAsBoolean()).toList());
    }

    /** Completed native MCP receipts cannot hide a TypeError thrown after several calls in one wrapper. */
    @Test
    public void sequentialLiteralMcpWrappersRetainOuterFailures() {
        String script = "const a = await tools.mcp__ccqa_acceptance__ccqa_get_success({});\n"
                + "const b = await tools.mcp__ccqa_acceptance__ccqa_get_expected_error({});\ntext(a.content.missing.field);\n";
        for (String header : List.of("Script failed", "Script error: TypeError")) {
            JsonArray records = catalogMcpScope();
            JsonObject wrapper = call("outer-sequence", script);
            wrapper.getAsJsonObject("payload").add("internal_chat_message_metadata_passthrough", JsonParser.parseString("{\"turn_id\":\"model-turn\"}"));
            records.add(wrapper);
            records.add(nativeCatalogMcp("native-sequence-success", "ccqa_get_success", "completed"));
            records.add(nativeCatalogMcp("native-sequence-error", "ccqa_get_expected_error", "completed"));
            records.add(output("outer-sequence", header + "\nOutput:\nTypeError: Cannot read properties of undefined"));
            List<JsonObject> projected = blocks(records);
            assertEquals(header, List.of("exec", "ccqa_get_success", "ccqa_get_expected_error"), toolNames(projected));
            JsonObject result = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))
                    && "outer-sequence".equals(string(block, "tool_use_id"))).findFirst().orElseThrow();
            assertTrue(header, result.get("is_error").getAsBoolean());
            assertTrue(header, string(result, "content").contains("TypeError: Cannot read properties of undefined"));
        }
    }

    /** Settled rejections describe their own calls, not the TypeError the wrapper throws afterwards. */
    @Test
    public void settledMcpRejectionsRetainOuterFailures() {
        JsonArray records = catalogMcpScope();
        records.add(call("settled-failure", "const rs = await Promise.allSettled([tools.mcp__ccqa_acceptance__ccqa_get_success({}),"
                + "tools.mcp__ccqa_acceptance__ccqa_get_expected_error({})]);"
                + "for (let i=0;i<rs.length;i++) text({index:i,...rs[i]});\ntext(rs[0].value.content);\n"));
        records.add(output("settled-failure", "Script failed\nOutput:\nTypeError: Cannot read properties of undefined",
                "{\"index\":0,\"status\":\"rejected\",\"reason\":\"first rejected\"}",
                "{\"index\":1,\"status\":\"rejected\",\"reason\":\"second rejected\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("exec"), toolNames(projected));
        JsonObject result = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))).findFirst().orElseThrow();
        assertTrue(result.get("is_error").getAsBoolean());
        assertTrue(string(result, "content").contains("TypeError: Cannot read properties of undefined"));
    }

    /** Fallback wrapper cards keep the turn that opened them after a later turn has started. */
    @Test
    public void wrapperFallbackKeepsItsOwnTurnAfterTheNextTurnStarts() {
        String script = "text(await tools.mcp__ccqa_acceptance__ccqa_get_success({}));";
        JsonArray nextTurn = new JsonArray();
        nextTurn.add(JsonParser.parseString("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"next-turn\"}}"));
        nextTurn.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"next-turn\"}}"));
        JsonObject question = JsonParser.parseString("{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\","
                + "\"content\":[{\"type\":\"input_text\",\"text\":\"next question\"}]}}").getAsJsonObject();

        JsonArray unanswered = catalogMcpScope();
        unanswered.add(call("unanswered", script));
        unanswered.addAll(nextTurn.deepCopy());
        unanswered.add(question.deepCopy());
        List<JsonObject> legacy = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(unanswered);
        assertEquals("native-turn", turnOf(legacy, "tool_use", "unanswered"));
        assertEquals("next-turn", string(legacy.get(legacy.size() - 1).getAsJsonObject("raw"), "codexTurnId"));

        JsonArray failed = catalogMcpScope();
        failed.add(call("late-failure", script));
        failed.add(nativeCatalogMcp("native-late", "ccqa_get_success", "completed"));
        failed.addAll(nextTurn.deepCopy());
        failed.add(output("late-failure", "Script failed\nOutput:\nTypeError: late"));
        List<JsonObject> opaque = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(failed);
        assertEquals("native-turn", turnOf(opaque, "tool_use", "late-failure"));
        assertEquals("native-turn", turnOf(opaque, "tool_result", "late-failure"));
    }

    private static String turnOf(List<JsonObject> messages, String type, String toolId) {
        return messages.stream().map(message -> message.getAsJsonObject("raw")).filter(raw -> {
            JsonObject block = raw.getAsJsonArray("content").get(0).getAsJsonObject();
            return type.equals(string(block, "type")) && toolId.equals(string(block, "tool_use".equals(type) ? "id" : "tool_use_id"));
        }).map(raw -> string(raw, "codexTurnId")).findFirst().orElseThrow();
    }

    /** The owned PyCharm history also contains an independent catalog-discovery exec that must remain visible. */
    @Test
    public void catalogDiscoveryRemainsDistinctFromSequentialMcpWrapper() {
        JsonArray records = catalogMcpScope();
        String discovery = "const matches = ALL_TOOLS.filter(x => /ccqa.*(get_success|get_expected_error)/.test(x.name)); "
                + "for (const t of matches) text(t);\n";
        assertFalse(CodexKnownExecReplay.begin(call("catalog-discovery", discovery), "root", "native-turn").hasStaticActions());
        records.add(call("catalog-discovery", discovery));
        records.add(output("catalog-discovery", "Script completed", "{\"name\":\"ccqa_get_success\"}", "{\"name\":\"ccqa_get_expected_error\"}"));
        records.add(call("literal-sequence", "text(await tools.mcp__ccqa_acceptance__ccqa_get_success({}));\n"
                + "text(await tools.mcp__ccqa_acceptance__ccqa_get_expected_error({}));\n"));
        records.add(nativeCatalogMcp("native-success", "ccqa_get_success", "completed"));
        records.add(nativeCatalogMcp("native-error", "ccqa_get_expected_error", "failed"));
        records.add(output("literal-sequence", "Script completed", "{\"isError\":false}", "{\"isError\":true}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("exec", "ccqa_get_success", "ccqa_get_expected_error"), toolNames(projected));
        List<JsonObject> tools = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))).toList();
        List<JsonObject> results = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))).toList();
        assertEquals(List.of("catalog-discovery", "native-success", "native-error"), tools.stream().map(tool -> string(tool, "id")).toList());
        assertEquals(List.of("catalog-discovery", "native-success", "native-error"), results.stream().map(result -> string(result, "tool_use_id")).toList());
        assertEquals(List.of(false, false, true), results.stream().map(result -> result.get("is_error").getAsBoolean()).toList());
    }

    /** A completed MCP call cannot hide a later TypeError from a shadowed output function. */
    @Test
    public void catalogSelectedMcpWrappersRetainShadowedOutputFailures() {
        String script = catalogMcpScript("ccqa_get_success");
        List<String> shadowed = List.of(
                script.replace("const t =", "const text =").replace("tools[t.name]", "tools[text.name]"),
                script.replace("const r =", "const text =").replace("text(r)", "text(text)"));
        for (String invalid : shadowed) {
            JsonObject wrapper = call("catalog-shadow", invalid);
            assertFalse(invalid, CodexKnownExecReplay.begin(wrapper, "root", "native-turn").hasStaticActions());
            JsonArray records = catalogMcpScope();
            records.add(wrapper);
            records.add(nativeCatalogMcp("native-success", "ccqa_get_success", "completed"));
            records.add(output("catalog-shadow", "Script failed\nOutput:\nTypeError: text is not a function"));
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("exec", "ccqa_get_success"), toolNames(projected));
            JsonObject exec = projected.stream().filter(block -> "tool_use".equals(string(block, "type"))
                    && "exec".equals(string(block, "name"))).findFirst().orElseThrow();
            JsonObject execResult = projected.stream().filter(block -> "tool_result".equals(string(block, "type"))
                    && string(exec, "id").equals(string(block, "tool_use_id"))).findFirst().orElseThrow();
            assertTrue(execResult.get("is_error").getAsBoolean());
            assertTrue(string(execResult, "content").contains("TypeError: text is not a function"));
        }
    }

    /** Only the outer bindings can shadow the wrapper globals or collide with each other. */
    @Test
    public void catalogSelectedMcpWrappersRejectConflictingOuterBindings() {
        String script = catalogMcpScript("ccqa_get_success");
        for (String reserved : List.of("tools", "ALL_TOOLS", "text")) {
            String selected = script.replace("const t =", "const " + reserved + " =")
                    .replace("tools[t.name]", "tools[" + reserved + ".name]");
            String result = script.replace("const r =", "const " + reserved + " =").replace("text(r)", "text(" + reserved + ")");
            assertFalse(selected, CodexKnownExecReplay.begin(call("selected-binding", selected), "root", "native-turn").hasStaticActions());
            assertFalse(result, CodexKnownExecReplay.begin(call("result-binding", result), "root", "native-turn").hasStaticActions());
        }
        String duplicate = script.replace("const r =", "const t =").replace("text(r)", "text(t)");
        assertFalse(CodexKnownExecReplay.begin(call("duplicate-binding", duplicate), "root", "native-turn").hasStaticActions());
    }

    /** Dynamic arguments and work beyond the single catalog-selected call must remain reviewable as exec. */
    @Test
    public void catalogSelectedMcpWrappersRequireCompleteLiteralScripts() {
        String script = catalogMcpScript("ccqa_get_success");
        for (String unknown : List.of("text('extra');" + script, script + "text('extra');",
                script.replace("({})", "(getArguments())"), script.replace("({})", "({value: getValue()})"),
                script.replace(".test(t.name)", ".test(other.name)"), script.replace("tools[t.name]", "tools[other.name]"),
                script.replace("text(r)", "text(other)"), script.replace("ccqa_get_success$", "ccqa_get_.*$"),
                script.replace("ALL_TOOLS.find", "getTools().find"), "text(await tools[selected.name]({}));",
                "text('" + script.replace("'", "\\'").replace("\n", "\\n") + "');")) {
            JsonArray records = catalogMcpScope();
            records.add(call("unknown-catalog", unknown));
            records.add(nativeCatalogMcp("native", "ccqa_get_success", "completed"));
            records.add(output("unknown-catalog", "Script completed"));
            assertTrue(unknown, toolNames(blocks(records)).contains("exec"));
        }
    }

    /** A selector does not own missing, ambiguous or unrelated native receipts. */
    @Test
    public void catalogSelectedMcpWrappersRequireUniqueMatchingNativeReceipts() {
        for (String mismatch : List.of("missing", "arguments", "tool", "server", "duplicate", "thread", "turn")) {
            JsonArray records = catalogMcpScope();
            records.add(call("catalog-mismatch", catalogMcpScript("ccqa_get_success")));
            JsonObject event = nativeCatalogMcp("native", "ccqa_get_success", "completed");
            JsonObject payload = event.getAsJsonObject("payload");
            JsonObject item = payload.getAsJsonObject("item");
            switch (mismatch) {
                case "arguments" -> item.add("arguments", JsonParser.parseString("{\"different\":true}"));
                case "tool" -> item.addProperty("tool", "another_tool");
                case "server" -> item.addProperty("server", "prefix_ccqa_acceptance");
                case "thread" -> payload.addProperty("thread_id", "another-root");
                case "turn" -> payload.addProperty("turn_id", "another-turn");
                default -> { }
            }
            if (!mismatch.equals("missing")) {
                records.add(event);
            }
            if (mismatch.equals("duplicate")) {
                records.add(nativeCatalogMcp("another-native", "ccqa_get_success", "completed"));
            }
            records.add(output("catalog-mismatch", "Script completed"));
            assertTrue(mismatch, toolNames(blocks(records)).contains("exec"));
        }
    }

    private static JsonArray catalogMcpScope() {
        JsonArray records = new JsonArray();
        records.add(JsonParser.parseString("{\"type\":\"session_meta\",\"payload\":{\"id\":\"root\"}}"));
        records.add(JsonParser.parseString("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"native-turn\"}}"));
        return records;
    }

    private static String catalogMcpScript(String tool) {
        return "const t = ALL_TOOLS.find(t => /(?:^|__)" + tool
                + "$/.test(t.name) && t.name.includes(\"ccqa_acceptance\")); const r = await tools[t.name]({}); text(r);\n";
    }

    private static String catalogMcpTextContentScript(String tool) {
        return "const t = ALL_TOOLS.find(x => x.name.endsWith(\"" + tool
                + "\") && x.name.includes(\"ccqa_acceptance\")); const r = await tools[t.name]({}); "
                + "for (const c of r.content ?? []) { if (c.type === \"text\") text(c.text); }\n";
    }

    private static JsonObject nativeCatalogMcp(String id, String tool, String status) {
        JsonObject event = JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"native-turn",
                "item":{"type":"McpToolCall","server":"ccqa_acceptance","arguments":{},
                "result":{"content":[{"type":"text"}]}}}}
                """).getAsJsonObject();
        JsonObject item = event.getAsJsonObject("payload").getAsJsonObject("item");
        item.addProperty("id", id);
        item.addProperty("tool", tool);
        item.addProperty("status", status);
        item.getAsJsonObject("result").getAsJsonArray("content").get(0).getAsJsonObject()
                .addProperty("text", status.equals("completed") ? "CCQA_MCP_SUCCESS" : "CCQA_MCP_EXPECTED_ERROR");
        return event;
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

    /** Foreign native outcomes remain visible without replacing the wrapper's own work. */
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
        assertTrue(toolNames(blocks(records)).contains("exec"));
        assertTrue(blocks(records).stream().anyMatch(block -> "foreign-edit".equals(string(block, "id"))));
        assertTrue(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records).stream()
                .anyMatch(message -> message.toString().contains("foreign-edit")
                        && "other-turn".equals(string(message.getAsJsonObject("raw"), "codexTurnId"))));
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
                "await Promise.allSettled([computedEntry,tools.exec_command({cmd:'npm test'})]);",
                "await Promise.allSettled([tools.exec_command({cmd:'npm test'}),...extra]);",
                "await tools.exec_command({cmd:true});await tools.write_stdin({session_id:1,chars:''});",
                "await tools.exec_command({cmd:'npm test'});await tools.future_tool({});")) {
            JsonArray unknown = new JsonArray();
            unknown.add(call("unknown", script));
            unknown.add(output("unknown", indexed(0, "{\"exit_code\":0}"), indexed(1, "{\"exit_code\":0}")));
            assertTrue(script, toolNames(blocks(unknown)).contains("exec"));
        }
    }

    /** A local Promise result keeps its own slot without hiding the command beside it. */
    @Test
    public void replaysCommandsBesideLocalPromiseResultsInEitherOrder() {
        String expression = "Promise.resolve(ALL_TOOLS.filter(x => (x.name+\" \"+x.description).includes('jetbrains'))"
                + ".map(x=>({name:x.name, description:x.description.slice(0,240)})))";
        String command = "tools.exec_command({cmd:\"pwd && rg --files -g 'AGENTS.md' -g 'CLAUDE.md' -g '!node_modules'\","
                + "workdir:'/project',max_output_tokens:7000})";
        for (boolean localFirst : List.of(false, true)) {
            for (boolean nativeReceipt : List.of(false, true)) {
                JsonArray records = new JsonArray();
                records.add(call("local-and-command", "const results=await Promise.allSettled(["
                        + (localFirst ? expression + "," + command : command + "," + expression)
                        + "]);results.forEach((r,i)=>text({i,...r}));"));
                List<JsonObject> preview = blocks(records);
                assertEquals(localFirst ? List.of("Promise.resolve", "bash") : List.of("bash", "Promise.resolve"), toolNames(preview));
                String localId = string(preview.get(localFirst ? 0 : 1), "id");
                if (nativeReceipt) {
                    JsonObject nativeRecord = nativeCommand("native-command", "completed", 0);
                    nativeRecord.getAsJsonObject("payload").getAsJsonObject("item")
                            .addProperty("command", "pwd && rg --files -g 'AGENTS.md' -g 'CLAUDE.md' -g '!node_modules'");
                    records.add(nativeRecord);
                }
                records.add(output("local-and-command", "Script completed\nOutput:\n", indexed(localFirst ? 0 : 1, "[]"),
                        indexed(localFirst ? 1 : 0, "{\"exit_code\":0,\"output\":\"project\\nAGENTS.md\"}")));
                List<JsonObject> projected = blocks(records);
                assertEquals(toolNames(preview), toolNames(projected));
                String commandOutput = nativeReceipt ? "native-command output" : "project\nAGENTS.md";
                assertEquals(localFirst ? List.of("[]", commandOutput) : List.of(commandOutput, "[]"), results(projected));
                JsonObject local = projected.get(localFirst ? 0 : 2);
                assertEquals(localId, string(local, "id"));
                assertEquals(expression, string(local.getAsJsonObject("input"), "code"));
                assertFalse(projected.stream().anyMatch(block -> block.has("is_error") && block.get("is_error").getAsBoolean()));
                JsonArray conversation = new JsonArray();
                conversation.add(JsonParser.parseString("""
                        {"type":"response_item","payload":{"type":"message","role":"user",
                        "content":[{"type":"input_text","text":"Find project instructions and IDE tools."}]}}
                        """));
                records.forEach(conversation::add);
                assertEquals(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(conversation),
                        HistoryMessageInjector.paginateCodexMessages(conversation, null, 30).messages);
            }
        }
    }

    /** Local values remain data even when their fields resemble a failed command result. */
    @Test
    public void keepsLocalPromiseValuesSeparateFromCommandStatus() {
        for (List<String> value : List.of(List.of("null", "null"), List.of("false", "false"), List.of("42", "42"),
                List.of("\"failed is only text\"", "failed is only text"),
                List.of("{\"exit_code\":9,\"output\":\"local data\"}", "{\"exit_code\":9,\"output\":\"local data\"}"))) {
            JsonArray records = new JsonArray();
            records.add(call("local-data", "await Promise.allSettled([tools.exec_command({cmd:'npm test'}),Promise.resolve(value)]);"));
            records.add(output("local-data", indexed(0, "{\"exit_code\":0,\"output\":\"passed\"}"), indexed(1, value.get(0))));
            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("bash", "Promise.resolve"), toolNames(projected));
            assertEquals(List.of("passed", value.get(1)), results(projected));
            assertFalse(projected.stream().anyMatch(block -> block.has("is_error") && block.get("is_error").getAsBoolean()));
        }
    }

    /** Promise.all returns plain values, so a local status field cannot become a settled receipt. */
    @Test
    public void keepsPromiseAllLocalStatusObjectsAsData() {
        for (String value : List.of("{\"status\":\"fulfilled\",\"value\":[\"inspect\"]}",
                "{\"status\":\"rejected\",\"reason\":\"local status\"}")) {
            JsonArray records = new JsonArray();
            records.add(call("plain-status", "const results=await Promise.all([tools.exec_command({cmd:'npm test'}),"
                    + "Promise.resolve(" + value + ")]);results.forEach((result,i)=>text({i,result}));"));
            records.add(output("plain-status", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"passed\"}}",
                    "{\"i\":1,\"result\":" + value + "}"));

            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("bash", "Promise.resolve"), toolNames(projected));
            assertEquals(List.of("passed", value), results(projected));
            assertFalse(projected.get(3).get("is_error").getAsBoolean());
        }
    }

    /** Flattened Promise.all values cannot prove which fields belong to an outcome envelope. */
    @Test
    public void keepsFlattenedLocalPromiseAllValuesReviewable() {
        for (String fields : List.of("\"status\":\"fulfilled\",\"value\":[\"inspect\"]",
                "\"status\":\"rejected\",\"reason\":\"local status\"", "\"error\":\"local data\",\"details\":[1,2]")) {
            JsonArray records = new JsonArray();
            records.add(call("flat-local", "const results=await Promise.all([tools.exec_command({cmd:'npm test'}),"
                    + "Promise.resolve({" + fields + "})]);results.forEach((r,i)=>{"
                    + "if(i===0){text({i,result:r});}else{text({i,...r});}});"));
            String localOutput = "{\"i\":1," + fields + "}";
            records.add(output("flat-local", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"passed\"}}", localOutput));

            List<JsonObject> projected = blocks(records);
            assertTrue("unproven local fields must stay in the original wrapper", toolNames(projected).contains("exec"));
            assertTrue(results(projected).stream().anyMatch(result -> result.contains(localOutput)));
        }
    }

    /** Condensed allSettled output has already unwrapped the promise, so local status fields remain data. */
    @Test
    public void keepsCondensedSettledLocalStatusObjectsAsData() {
        for (String value : List.of("{\"status\":\"fulfilled\",\"value\":[\"inspect\"]}",
                "{\"status\":\"rejected\",\"reason\":\"local status\"}")) {
            JsonArray records = new JsonArray();
            records.add(call("condensed-status", "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                    + "Promise.resolve(" + value + ")]);results.forEach((r,i)=>text({i,result:r.value}));"));
            records.add(output("condensed-status", "{\"i\":0,\"result\":{\"exit_code\":0,\"output\":\"passed\"}}",
                    "{\"i\":1,\"result\":" + value + "}"));

            List<JsonObject> projected = blocks(records);
            assertEquals(List.of("bash", "Promise.resolve"), toolNames(projected));
            assertEquals(List.of("passed", value), results(projected));
            assertFalse(projected.get(3).get("is_error").getAsBoolean());
        }
    }

    /** Whole settled receipts still carry explicit local failures without unwrapping a fulfilled value twice. */
    @Test
    public void restoresWholeNestedLocalReceiptsAcrossBatchPrinters() {
        String value = "{\"status\":\"rejected\",\"reason\":\"local status\"}";
        for (String printer : List.of("results.forEach((r,i)=>text({i,result:r}));",
                "results.forEach((r,i)=>{text({i,result:r});});",
                "results.forEach((result,index)=>text({result,index}));",
                "for(let i=0;i<results.length;i++){const r=results[i];text({i,result:r});}")) {
            for (boolean rejected : List.of(false, true)) {
                JsonArray records = new JsonArray();
                String expression = rejected ? "Promise.reject('local computation failed')" : value;
                records.add(call("whole-local", "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                        + "Promise.resolve(" + expression + ")]);" + printer));
                String key = printer.contains("result,index") ? "index" : "i";
                String outcome = rejected ? "{\"status\":\"rejected\",\"reason\":\"local computation failed\"}"
                        : "{\"status\":\"fulfilled\",\"value\":" + value + "}";
                records.add(output("whole-local", "{\"" + key + "\":0,\"result\":{\"status\":\"fulfilled\","
                        + "\"value\":{\"exit_code\":0,\"output\":\"passed\"}}}", "{\"" + key + "\":1,\"result\":" + outcome + "}"));

                List<JsonObject> projected = blocks(records);
                assertEquals(List.of("bash", "Promise.resolve"), toolNames(projected));
                assertEquals(List.of("passed", rejected ? "local computation failed" : value), results(projected));
                assertEquals(rejected, projected.get(3).get("is_error").getAsBoolean());
            }
        }
    }

    /** A whole receipt printed for one slot cannot change the meaning of a sibling's plain local value. */
    @Test
    public void keepsBranchSpecificLocalValuesSeparateFromWholeReceipts() {
        String value = "{\"status\":\"rejected\",\"reason\":\"local status\"}";
        JsonArray records = new JsonArray();
        records.add(call("mixed-printers", "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "Promise.resolve(" + value + ")]);results.forEach((r,i)=>{"
                + "if(i===0){text({i,result:r});}else{text({i,result:r.value});}});"));
        records.add(output("mixed-printers", "{\"i\":0,\"result\":{\"status\":\"fulfilled\","
                + "\"value\":{\"exit_code\":0,\"output\":\"passed\"}}}", "{\"i\":1,\"result\":" + value + "}"));

        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "Promise.resolve"), toolNames(projected));
        assertEquals(List.of("passed", value), results(projected));
        assertFalse(projected.get(3).get("is_error").getAsBoolean());
    }

    /** Local values keep their fields even when they resemble replay outcome metadata. */
    @Test
    public void keepsRejectionLikeLocalFieldsInsideTheirValue() {
        String value = "{\"codexExecRejected\":true,\"is_error\":true,\"output\":\"local data\"}";
        JsonArray records = new JsonArray();
        records.add(call("local-fields", "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                + "Promise.resolve(" + value + ")]);results.forEach((r,i)=>text({i,...r}));"));
        records.add(output("local-fields", indexed(0, "{\"exit_code\":0,\"output\":\"passed\"}"), indexed(1, value)));

        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "Promise.resolve"), toolNames(projected));
        assertEquals(List.of("passed", value), results(projected));
        assertFalse(projected.get(3).get("is_error").getAsBoolean());
    }

    /** Printed index labels own local arrays and primitive values just as they own command receipts. */
    @Test
    public void restoresLabeledLocalValuesAlongsideCommands() {
        for (String printer : List.of(
                "results.forEach((r,i)=>{text('Result '+i);text(r.value);});",
                "for(let i=0;i<results.length;i++){text('Result '+i);const r=results[i];text(r.status==='fulfilled'?r.value:r.reason);}")) {
            for (String value : List.of("[]", "[{\"name\":\"inspect\",\"description\":\"IDE navigation\"}]", "null", "false", "42", "tool descriptions", "  inspect  ", "Result 0", "")) {
                JsonArray records = new JsonArray();
                records.add(call("labeled-local", "const results=await Promise.allSettled([tools.exec_command({cmd:'npm test'}),"
                        + "Promise.resolve(value)]);" + printer));
                records.add(output("labeled-local", "Result 0", "{\"exit_code\":0,\"output\":\"passed\"}", "Result 1", value));

                List<JsonObject> projected = blocks(records);
                assertEquals(value, List.of("bash", "Promise.resolve"), toolNames(projected));
                assertEquals(List.of("passed", value), results(projected));
                assertFalse(projected.get(3).get("is_error").getAsBoolean());
            }
        }
    }

    /** Settled local rejections do not fail a command whose independent receipt succeeded. */
    @Test
    public void preservesLocalPromiseRejectionWithoutFailingItsSiblingCommand() {
        JsonArray records = new JsonArray();
        records.add(call("local-rejection", "await Promise.allSettled([tools.exec_command({cmd:'npm test'}),Promise.resolve(value)]);"));
        records.add(output("local-rejection", indexed(0, "{\"exit_code\":0,\"output\":\"passed\"}"),
                "{\"i\":1,\"status\":\"rejected\",\"reason\":\"local computation failed\"}"));
        List<JsonObject> projected = blocks(records);
        assertEquals(List.of("bash", "Promise.resolve"), toolNames(projected));
        assertEquals(List.of("passed", "local computation failed"), results(projected));
        assertFalse(projected.get(1).get("is_error").getAsBoolean());
        assertTrue(projected.get(3).get("is_error").getAsBoolean());
    }

    /** A missing or unindexed local receipt keeps the wrapper inspectable instead of discarding that work. */
    @Test
    public void keepsUnpairedLocalPromiseOutputInTheWrapper() {
        for (boolean indexed : List.of(false, true)) {
            JsonArray records = new JsonArray();
            records.add(call("missing-local", "await Promise.allSettled([tools.exec_command({cmd:'npm test'}),Promise.resolve(value)]);"));
            records.add(output("missing-local", indexed ? indexed(0, "{\"exit_code\":0,\"output\":\"passed\"}")
                    : "{\"exit_code\":0,\"output\":\"passed\"}", "local output without an index"));
            List<JsonObject> projected = blocks(records);
            assertTrue(toolNames(projected).contains("exec"));
            assertTrue(results(projected).get(0).contains("local output without an index"));
        }
    }

    /** Thread and turn boundaries exclude foreign attribution while retaining every independent native outcome. */
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
        assertTrue(toolNames(blocks).contains("exec"));
        assertEquals(2, blocks.stream().filter(block -> "foreign".equals(string(block, "id"))).count());
        assertEquals(List.of("first", "second"), blocks.stream().filter(block -> "tool_use".equals(string(block, "type")))
                .filter(block -> List.of("first", "second").contains(string(block, "id")))
                .map(block -> string(block, "id")).toList());
        assertEquals(List.of(true, false), blocks.stream().filter(block -> "tool_result".equals(string(block, "type")))
                .filter(block -> List.of("first", "second").contains(string(block, "tool_use_id")))
                .map(block -> block.get("is_error").getAsBoolean()).toList());
        assertTrue(results(blocks).containsAll(List.of("first output", "second output", "shared output is not an independent result")));
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
