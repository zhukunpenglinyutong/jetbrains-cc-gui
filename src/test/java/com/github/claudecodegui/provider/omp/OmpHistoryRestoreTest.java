package com.github.claudecodegui.provider.omp;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Restored omp sessions: session titles, per-step/turn usage and tool mapping (contract sections 3-5). */
public class OmpHistoryRestoreTest {

    private static final String SID = "019fe705-27fd-712e-a1be-f972ef3773f3";
    private static final String CWD = "/work/project";

    private Path root;
    private int entry;
    private OmpHistoryReader reader;

    @Before
    public void setUp() throws Exception {
        root = Files.createTempDirectory("omp-restore-test");
        entry = 0;
        reader = new OmpHistoryReader(root, new Gson());
    }

    @After
    public void tearDown() throws Exception {
        try (Stream<Path> paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
        }
    }

    // ---- session titles ----

    @Test
    public void listUsesNonEmptyTitleSlot() throws Exception {
        writeSession(titleSlot("Refactor the parser"), header(), user("fix the build"));
        assertEquals("Refactor the parser", listedTitle());
    }

    @Test
    public void listFallsBackToFirstPromptWhenTitleSlotIsEmpty() throws Exception {
        writeSession(titleSlot(""), header(), user("fix the build"));
        assertEquals("fix the build", listedTitle());
    }

    @Test
    public void listFallsBackToFirstPromptWhenTitleSlotIsMissing() throws Exception {
        writeSession(header(), user("fix the build"));
        assertEquals("fix the build", listedTitle());
    }

    @Test
    public void listFallsBackToGenericLabelWithoutPrompt() throws Exception {
        writeSession(titleSlot(""), header());
        assertEquals("OMP session 019fe705", listedTitle());
    }

    // ---- usage ----

    @Test
    public void assistantMessagesCarryClaudeUsageAndTurnTotals() throws Exception {
        writeSession(header(),
                user("do it"),
                assistant("a1", usage(4, 179, 0, 14888, 15071, 0.1227),
                        "[{'type':'text','text':'working'},{'type':'toolCall','id':'c1','name':'bash','arguments':{'command':'ls'}}]"),
                toolResult("c1", "bash", "out", "{}", false),
                // A step without cost still adds its tokens to the turn.
                assistant("a2", usage(10, 20, 5, 0, 35, null),
                        "[{'type':'text','text':'done'}]"),
                user("again"),
                assistant("a3", usage(1, 2, 0, 0, 3, 0.5),
                        "[{'type':'text','text':'ok'}]"));

        List<JsonObject> messages = load();
        List<JsonObject> assistants = assistantEnvelopes(messages);
        assertEquals(4, assistants.size());

        JsonObject firstStepLast = assistants.get(1); // tool_use envelope closes step a1
        JsonObject usage1 = firstStepLast.getAsJsonObject("message").getAsJsonObject("usage");
        assertEquals(4, usage1.get("input_tokens").getAsLong());
        assertEquals(179, usage1.get("output_tokens").getAsLong());
        assertEquals(0, usage1.get("cache_read_input_tokens").getAsLong());
        assertEquals(14888, usage1.get("cache_creation_input_tokens").getAsLong());
        assertEquals(15071, usage1.get("total_tokens").getAsLong());
        assertEquals(0.1227, usage1.get("cost_usd").getAsDouble(), 1e-9);
        assertFalse(usage1.has("model_context_window"));
        assertFalse(firstStepLast.has("turnUsage"));
        assertFalse(assistants.get(0).getAsJsonObject("message").has("usage"));

        JsonObject secondStep = assistants.get(2);
        JsonObject usage2 = secondStep.getAsJsonObject("message").getAsJsonObject("usage");
        assertFalse(usage2.has("cost_usd"));
        JsonObject turn = secondStep.getAsJsonObject("turnUsage");
        assertEquals(14, turn.get("input_tokens").getAsLong());
        assertEquals(199, turn.get("output_tokens").getAsLong());
        assertEquals(5, turn.get("cache_read_input_tokens").getAsLong());
        assertEquals(14888, turn.get("cache_creation_input_tokens").getAsLong());
        assertEquals(15106, turn.get("total_tokens").getAsLong());
        assertEquals(0.1227, secondStep.get("turnCostUsd").getAsDouble(), 1e-9);

        JsonObject lastTurn = assistants.get(3);
        assertEquals(3, lastTurn.getAsJsonObject("turnUsage").get("total_tokens").getAsLong());
        assertEquals(0.5, lastTurn.get("turnCostUsd").getAsDouble(), 1e-9);
    }

    @Test
    public void assistantWithoutUsageGetsNoUsageFields() throws Exception {
        writeSession(header(), user("hi"), assistant("a1", null, "[{'type':'text','text':'hello'}]"));
        JsonObject envelope = assistantEnvelopes(load()).get(0);
        assertFalse(envelope.getAsJsonObject("message").has("usage"));
        assertFalse(envelope.has("turnUsage"));
        assertFalse(envelope.has("turnCostUsd"));
    }

    // ---- todo ----

    @Test
    public void todoBecomesTodoWriteDroppingAbandonedAndMappingBlocked() throws Exception {
        JsonObject details = json("{'op':'init','phases':["
                + "{'name':'A','tasks':[{'content':'one','status':'in_progress'},{'content':'gone','status':'abandoned'}]},"
                + "{'name':'B','tasks':[{'content':'two','status':'blocked'},{'content':'three','status':'completed'}]}"
                + "]}");
        writeSession(header(), user("plan"),
                assistant("a1", null, call("t1", "todo", "{'ops':[]}")),
                toolResult("t1", "todo", "Todo updated", details.toString(), false));

        List<JsonObject> blocks = blocks(load(), "tool_use");
        assertEquals(1, blocks.size());
        assertEquals("TodoWrite", blocks.get(0).get("name").getAsString());
        assertEquals("t1", blocks.get(0).get("id").getAsString());
        JsonArray todos = blocks.get(0).getAsJsonObject("input").getAsJsonArray("todos");
        assertEquals(3, todos.size());
        assertEquals("one", todos.get(0).getAsJsonObject().get("content").getAsString());
        assertEquals("in_progress", todos.get(0).getAsJsonObject().get("status").getAsString());
        assertEquals("one", todos.get(0).getAsJsonObject().get("activeForm").getAsString());
        assertEquals("two", todos.get(1).getAsJsonObject().get("content").getAsString());
        assertEquals("pending", todos.get(1).getAsJsonObject().get("status").getAsString());
        assertEquals("completed", todos.get(2).getAsJsonObject().get("status").getAsString());

        List<JsonObject> results = blocks(load(), "tool_result");
        assertEquals(1, results.size());
        assertEquals("t1", results.get(0).get("tool_use_id").getAsString());
        assertEquals("Todo updated", results.get(0).get("content").getAsString());
    }

    @Test
    public void todoWithoutPhasesOrWithErrorStaysTodo() throws Exception {
        writeSession(header(), user("plan"),
                assistant("a1", null, call("t1", "todo", "{'x':1}") + "," + call("t2", "todo", "{'x':2}")),
                toolResult("t1", "todo", "bad", "{}", false),
                toolResult("t2", "todo", "boom", "{'phases':[]}", true));
        List<JsonObject> blocks = blocks(load(), "tool_use");
        assertEquals("todo", blocks.get(0).get("name").getAsString());
        assertEquals("todo", blocks.get(1).get("name").getAsString());
        assertEquals(1, blocks.get(0).getAsJsonObject("input").get("x").getAsInt());
    }

    // ---- edit ----

    @Test
    public void editWithSeveralRegionsBecomesOneEditPerChangedRegion() throws Exception {
        String diff = " 1|a\n-2|b\n+2|c\n 3|d\n\n 10|x\n 11|y\n\n 20|p\n-21|q\n+21|r";
        JsonObject details = json("{'op':'update','path':'/abs/File.cs'}");
        details.addProperty("diff", diff);
        writeSession(header(), user("edit"),
                assistant("a1", null, call("e1", "edit", "{'input':'x'}")),
                toolResult("e1", "edit", "Updated", details.toString(), false));

        List<JsonObject> messages = load();
        List<JsonObject> uses = blocks(messages, "tool_use");
        assertEquals(2, uses.size());
        assertEquals("Edit", uses.get(0).get("name").getAsString());
        assertEquals("e1", uses.get(0).get("id").getAsString());
        assertEquals("e1#2", uses.get(1).get("id").getAsString());
        JsonObject in0 = uses.get(0).getAsJsonObject("input");
        assertEquals("/abs/File.cs", in0.get("file_path").getAsString());
        assertEquals("a\nb\nd", in0.get("old_string").getAsString());
        assertEquals("a\nc\nd", in0.get("new_string").getAsString());
        JsonObject in1 = uses.get(1).getAsJsonObject("input");
        assertEquals("p\nq", in1.get("old_string").getAsString());
        assertEquals("p\nr", in1.get("new_string").getAsString());

        List<JsonObject> results = blocks(messages, "tool_result");
        assertEquals(2, results.size());
        assertEquals("e1", results.get(0).get("tool_use_id").getAsString());
        assertEquals("Updated", results.get(0).get("content").getAsString());
        assertEquals("e1#2", results.get(1).get("tool_use_id").getAsString());
        assertEquals("", results.get(1).get("content").getAsString());
        assertFalse(results.get(1).get("is_error").getAsBoolean());
    }

    @Test
    public void editHunksPrintedBackToBackWithAJumpInLineNumbersAreSeparateRegions() throws Exception {
        String diff = " 3|keep\n-4|old\n+4|new\n 5|keep\n 28|far\n-29|old2\n+29|new2\n 30|end";
        JsonObject details = json("{'op':'update','path':'/abs/File.cs'}");
        details.addProperty("diff", diff);
        writeSession(header(), user("edit"),
                assistant("a1", null, call("e1", "edit", "{'input':'x'}")),
                toolResult("e1", "edit", "Updated", details.toString(), false));

        List<JsonObject> uses = blocks(load(), "tool_use");
        assertEquals(2, uses.size());
        assertEquals("e1", uses.get(0).get("id").getAsString());
        assertEquals("e1#2", uses.get(1).get("id").getAsString());
        assertEquals("Edit", uses.get(1).get("name").getAsString());
        assertEquals("keep\nold\nkeep", uses.get(0).getAsJsonObject("input").get("old_string").getAsString());
        assertEquals("keep\nnew\nkeep", uses.get(0).getAsJsonObject("input").get("new_string").getAsString());
        assertEquals("far\nold2\nend", uses.get(1).getAsJsonObject("input").get("old_string").getAsString());
        assertEquals("far\nnew2\nend", uses.get(1).getAsJsonObject("input").get("new_string").getAsString());
    }

    @Test
    public void multiFileEditNumbersBlocksAcrossFiles() throws Exception {
        JsonObject f1 = json("{'path':'/abs/a.cs','op':'update'}");
        f1.addProperty("diff", "-1|one\n+1|uno");
        JsonObject f2 = json("{'path':'/abs/b.cs','op':'update'}");
        f2.addProperty("diff", "-5|two\n+5|dos\n\n-9|three\n+9|tres");
        JsonObject details = new JsonObject();
        JsonArray perFile = new JsonArray();
        perFile.add(f1);
        perFile.add(f2);
        details.add("perFileResults", perFile);
        writeSession(header(), user("edit"),
                assistant("a1", null, call("e1", "edit", "{}")),
                toolResult("e1", "edit", "Updated 2 files", details.toString(), false));

        List<JsonObject> uses = blocks(load(), "tool_use");
        assertEquals(3, uses.size());
        assertEquals("e1", uses.get(0).get("id").getAsString());
        assertEquals("e1#2", uses.get(1).get("id").getAsString());
        assertEquals("e1#3", uses.get(2).get("id").getAsString());
        assertEquals("/abs/a.cs", uses.get(0).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("/abs/b.cs", uses.get(1).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("/abs/b.cs", uses.get(2).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("three", uses.get(2).getAsJsonObject("input").get("old_string").getAsString());
    }

    @Test
    public void editRegionsEndAtAnyLineThatIsNotADiffLineAndTolerateCrlf() throws Exception {
        JsonObject details = json("{'path':'/abs/File.cs'}");
        details.addProperty("diff", "-1|a\r\n+1|b\r\n... 40 unchanged lines ...\r\n-50|c\r\n+50|d");
        writeSession(header(), user("edit"),
                assistant("a1", null, call("e1", "edit", "{}")),
                toolResult("e1", "edit", "Updated", details.toString(), false));

        List<JsonObject> uses = blocks(load(), "tool_use");
        assertEquals(2, uses.size());
        assertEquals("a", uses.get(0).getAsJsonObject("input").get("old_string").getAsString());
        assertEquals("b", uses.get(0).getAsJsonObject("input").get("new_string").getAsString());
        assertEquals("c", uses.get(1).getAsJsonObject("input").get("old_string").getAsString());
        assertEquals("d", uses.get(1).getAsJsonObject("input").get("new_string").getAsString());
    }

    @Test
    public void editWithOnlyContextRegionsStaysEdit() throws Exception {
        JsonObject details = json("{'path':'/abs/File.cs'}");
        details.addProperty("diff", " 1|a\n 2|b\n\n 8|c");
        writeSession(header(), user("edit"),
                assistant("a1", null, call("e1", "edit", "{'path':'/abs/File.cs'}")),
                toolResult("e1", "edit", "Updated", details.toString(), false));

        List<JsonObject> uses = blocks(load(), "tool_use");
        assertEquals(1, uses.size());
        assertEquals("edit", uses.get(0).get("name").getAsString());
        assertFalse(uses.get(0).getAsJsonObject("input").has("old_string"));
        assertEquals("e1", blocks(load(), "tool_result").get(0).get("tool_use_id").getAsString());
    }

    @Test
    public void failedEditKeepsEditAndGainsFilePathFromArgsPath() throws Exception {
        writeSession(header(), user("edit"),
                assistant("a1", null, call("e1", "edit", "{'path':'/abs/x.ts','input':'whatever'}")),
                toolResult("e1", "edit", "mismatch", "{}", true));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("edit", use.get("name").getAsString());
        assertEquals("/abs/x.ts", use.getAsJsonObject("input").get("file_path").getAsString());
        assertTrue(blocks(load(), "tool_result").get(0).get("is_error").getAsBoolean());
    }

    @Test
    public void failedEditTakesFilePathFromFirstPathHeader() throws Exception {
        JsonObject args = new JsonObject();
        args.addProperty("input", "[src/Main.java#A1B2]\nPUT 1:\n+x\n[other.txt#C3D4]\n");
        writeSession(header(), user("edit"),
                assistant("a1", null, "[{'type':'toolCall','id':'e1','name':'edit','arguments':" + args + "}]"),
                toolResult("e1", "edit", "stale tag", "{}", true));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("edit", use.get("name").getAsString());
        assertEquals("src/Main.java", use.getAsJsonObject("input").get("file_path").getAsString());
        assertTrue(use.getAsJsonObject("input").has("input"));
    }

    // ---- write ----

    @Test
    public void writeToPlainPathBecomesWriteUsingResolvedPath() throws Exception {
        writeSession(header(), user("w"),
                assistant("a1", null, call("w1", "write", "{'path':'notes.md','content':'hello'}")),
                toolResult("w1", "write", "Wrote", "{'resolvedPath':'/real/notes.md'}", false));
        List<JsonObject> messages = load();
        JsonObject use = blocks(messages, "tool_use").get(0);
        assertEquals("Write", use.get("name").getAsString());
        assertEquals("/real/notes.md", use.getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("hello", use.getAsJsonObject("input").get("content").getAsString());
        JsonObject result = blocks(messages, "tool_result").get(0);
        assertEquals("w1", result.get("tool_use_id").getAsString());
        assertEquals("Wrote", result.get("content").getAsString());
    }

    @Test
    public void writeWithoutResolvedPathResolvesAgainstSessionCwd() throws Exception {
        writeSession(header(), user("w"),
                assistant("a1", null, call("w1", "write", "{'path':'sub/a.txt','content':'x'}")),
                toolResult("w1", "write", "Wrote", "{}", false));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("Write", use.get("name").getAsString());
        assertEquals(CWD + "/sub/a.txt", use.getAsJsonObject("input").get("file_path").getAsString());
    }

    @Test
    public void writeToUrlSchemePathStaysWrite() throws Exception {
        writeSession(header(), user("w"),
                assistant("a1", null, call("w1", "write", "{'path':'local://x.md','content':'x'}")),
                toolResult("w1", "write", "Wrote", "{'resolvedPath':'/tmp/x.md'}", false));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("write", use.get("name").getAsString());
        assertEquals("local://x.md", use.getAsJsonObject("input").get("path").getAsString());
    }

    @Test
    public void writeToPathOmpRewritesIsWriteAtResolvedPath() throws Exception {
        writeSession(header(), user("w"),
                assistant("a1", null, call("w1", "write", "{'path':'@/tmp/other/out.txt','content':'x'}")),
                toolResult("w1", "write", "Wrote", "{'resolvedPath':'/tmp/other/out.txt'}", false));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("Write", use.get("name").getAsString());
        assertEquals("/tmp/other/out.txt", use.getAsJsonObject("input").get("file_path").getAsString());
    }

    @Test
    public void writeToPathOmpRewritesStaysWriteWithoutResolvedPath() throws Exception {
        writeSession(header(), user("w"),
                assistant("a1", null, call("w1", "write", "{'path':'@/tmp/other/out.txt','content':'x'}")),
                toolResult("w1", "write", "denied", "{}", true));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("write", use.get("name").getAsString());
        assertEquals("@/tmp/other/out.txt", use.getAsJsonObject("input").get("path").getAsString());
    }

    @Test
    public void plainPathsAreTheOnesOmpWritesToAsWritten() {
        for (String path : new String[]{"notes.md", "src/a.ts", "/abs/a.ts", "~", "~/a", "C:\\a\\b.txt"}) {
            assertTrue(path, OmpToolMapper.isPlainPath(path, false));
        }
        for (boolean windows : new boolean[]{false, true}) {
            for (String path : new String[]{"@/abs/a", ":./a", "~name", "[src/a.ts#1A2B]", "bundle.zip:inner.txt",
                    "a\u00A0b", "/", "", " a", "xd://lsp"}) {
                assertFalse(path + " windows=" + windows, OmpToolMapper.isPlainPath(path, windows));
            }
        }
        assertFalse(OmpToolMapper.isPlainPath("/c/a", true));
        assertFalse(OmpToolMapper.isPlainPath("/abs/a.ts", true));
        for (String path : new String[]{"notes.md", "src/a.ts", "~", "~/a", "C:\\a\\b.txt"}) {
            assertTrue(path, OmpToolMapper.isPlainPath(path, true));
        }
    }

    @Test
    public void windowsPathRulesApplyOnlyToWindowsSessionsOnAWindowsHost() {
        assertFalse(OmpToolMapper.usesWindowsPathRules("/home/u/project", true));
        assertTrue(OmpToolMapper.usesWindowsPathRules("C:\\work\\project", true));
        assertTrue(OmpToolMapper.usesWindowsPathRules(null, true));
        assertFalse(OmpToolMapper.usesWindowsPathRules("/home/u/project", false));
        assertFalse(OmpToolMapper.usesWindowsPathRules("C:\\work\\project", false));
        assertFalse(OmpToolMapper.usesWindowsPathRules(null, false));
    }

    @Test
    public void writeWithoutResultToAnAbsolutePosixPathInAPosixSessionIsAWriteOnEveryHost() throws Exception {
        writeSession(header(), user("w"),
                assistant("a1", null, call("w1", "write", "{'path':'/home/u/x.txt','content':'x'}")));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("Write", use.get("name").getAsString());
        assertEquals("/home/u/x.txt", use.getAsJsonObject("input").get("file_path").getAsString());
    }

    // ---- task ----

    @Test
    public void taskBecomesOneTaskBlockPerEntry() throws Exception {
        String args = "{'agent':'scout','tasks':["
                + "{'name':'Audit','agent':'reviewer','task':'# Target'},"
                + "{'id':'second','assignment':'do b'},"
                + "{}]}";
        writeSession(header(), user("t"),
                assistant("a1", null, call("k1", "task", args)),
                toolResult("k1", "task", "Started", "{'async':true}", true));

        List<JsonObject> messages = load();
        List<JsonObject> uses = blocks(messages, "tool_use");
        assertEquals(3, uses.size());
        assertEquals("Task", uses.get(0).get("name").getAsString());
        assertEquals("k1", uses.get(0).get("id").getAsString());
        assertEquals("k1#2", uses.get(1).get("id").getAsString());
        assertEquals("k1#3", uses.get(2).get("id").getAsString());
        JsonObject in0 = uses.get(0).getAsJsonObject("input");
        assertEquals("Audit", in0.get("description").getAsString());
        assertEquals("# Target", in0.get("prompt").getAsString());
        assertEquals("reviewer", in0.get("subagent_type").getAsString());
        JsonObject in1 = uses.get(1).getAsJsonObject("input");
        assertEquals("second", in1.get("description").getAsString());
        assertEquals("do b", in1.get("prompt").getAsString());
        assertEquals("scout", in1.get("subagent_type").getAsString());
        JsonObject in2 = uses.get(2).getAsJsonObject("input");
        assertEquals("Task 3", in2.get("description").getAsString());
        assertEquals("", in2.get("prompt").getAsString());

        List<JsonObject> results = blocks(messages, "tool_result");
        assertEquals(3, results.size());
        assertEquals("Started", results.get(0).get("content").getAsString());
        assertEquals("", results.get(1).get("content").getAsString());
        assertTrue(results.get(2).get("is_error").getAsBoolean());
        assertEquals("k1#3", results.get(2).get("tool_use_id").getAsString());
    }

    @Test
    public void taskWithoutEntriesStaysTask() throws Exception {
        writeSession(header(), user("t"),
                assistant("a1", null, call("k1", "task", "{'tasks':[]}")),
                toolResult("k1", "task", "n/a", "{}", false));
        assertEquals("task", blocks(load(), "tool_use").get(0).get("name").getAsString());
    }

    // ---- calls without a result ----

    @Test
    public void callsWithoutResultAreMappedFromArgumentsOnlyWhereAllowed() throws Exception {
        writeSession(header(), user("go"),
                assistant("a1", null,
                        call("t1", "todo", "{'ops':[]}") + ","
                                + call("e1", "edit", "{'path':'/abs/x.ts'}") + ","
                                + call("w1", "write", "{'path':'w.txt','content':'c'}") + ","
                                + call("k1", "task", "{'tasks':[{'name':'N','task':'P'},{'name':'M','task':'Q'}]}")));

        List<JsonObject> messages = load();
        List<JsonObject> uses = blocks(messages, "tool_use");
        assertEquals(5, uses.size());
        assertEquals("todo", uses.get(0).get("name").getAsString());
        assertEquals("edit", uses.get(1).get("name").getAsString());
        assertEquals("/abs/x.ts", uses.get(1).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("Write", uses.get(2).get("name").getAsString());
        assertEquals(CWD + "/w.txt", uses.get(2).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("Task", uses.get(3).get("name").getAsString());
        assertEquals("k1#2", uses.get(4).get("id").getAsString());
        assertTrue(blocks(messages, "tool_result").isEmpty());
    }

    @Test
    public void unmappedToolsKeepTheirShapeAndOrder() throws Exception {
        writeSession(header(), user("go"),
                assistant("a1", null, "[{'type':'text','text':'hi'}," + call("b1", "bash", "{'command':'ls'}") + "]"),
                toolResult("b1", "bash", "file.txt", "{}", false));
        List<JsonObject> messages = load();
        assertEquals(4, messages.size());
        assertEquals("bash", blocks(messages, "tool_use").get(0).get("name").getAsString());
        assertEquals("ls", blocks(messages, "tool_use").get(0).getAsJsonObject("input").get("command").getAsString());
        JsonObject result = blocks(messages, "tool_result").get(0);
        assertEquals("b1", result.get("tool_use_id").getAsString());
        assertEquals("file.txt", result.get("content").getAsString());
        assertNull(messages.get(3).get("turnUsage"));
    }

    // ---- reused tool call ids ----

    @Test
    public void editCallsSharingAnIdAcrossTurnsRestoreWithTheirOwnFileAndResult() throws Exception {
        JsonObject first = json("{'op':'update','path':'/abs/a.txt'}");
        first.addProperty("diff", "-1|alpha\n+1|ALPHA");
        JsonObject second = json("{'op':'update','path':'/abs/b.txt'}");
        second.addProperty("diff", "-1|beta\n+1|BETA");
        writeSession(header(),
                user("first"),
                assistant("a1", null, call("call_0", "edit", "{'input':'x'}")),
                toolResult("call_0", "edit", "done A", first.toString(), false),
                user("second"),
                assistant("a2", null, call("call_0", "edit", "{'input':'y'}")),
                toolResult("call_0", "edit", "done B", second.toString(), false));

        List<JsonObject> messages = load();
        List<JsonObject> uses = blocks(messages, "tool_use");
        assertEquals(2, uses.size());
        assertEquals("/abs/a.txt", uses.get(0).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("alpha", uses.get(0).getAsJsonObject("input").get("old_string").getAsString());
        assertEquals("ALPHA", uses.get(0).getAsJsonObject("input").get("new_string").getAsString());
        assertEquals("/abs/b.txt", uses.get(1).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("beta", uses.get(1).getAsJsonObject("input").get("old_string").getAsString());
        assertEquals("BETA", uses.get(1).getAsJsonObject("input").get("new_string").getAsString());

        List<JsonObject> results = blocks(messages, "tool_result");
        assertEquals(2, results.size());
        assertEquals("done A", results.get(0).get("content").getAsString());
        assertEquals("done B", results.get(1).get("content").getAsString());
    }

    @Test
    public void resultOfAReusedIdGoesToTheLaterCallWhenTheEarlierOneNeverGotOne() throws Exception {
        JsonObject second = json("{'op':'update','path':'/abs/b.txt'}");
        second.addProperty("diff", "-1|beta\n+1|BETA");
        writeSession(header(),
                user("first"),
                assistant("a1", null, call("call_0", "edit", "{'path':'/abs/a.txt','input':'x'}")),
                user("second"),
                assistant("a2", null, call("call_0", "edit", "{'input':'y'}")),
                toolResult("call_0", "edit", "done B", second.toString(), false));

        List<JsonObject> messages = load();
        List<JsonObject> uses = blocks(messages, "tool_use");
        assertEquals(2, uses.size());
        assertEquals("/abs/a.txt", uses.get(0).getAsJsonObject("input").get("file_path").getAsString());
        assertFalse(uses.get(0).getAsJsonObject("input").has("new_string"));
        assertEquals("/abs/b.txt", uses.get(1).getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("BETA", uses.get(1).getAsJsonObject("input").get("new_string").getAsString());

        List<JsonObject> results = blocks(messages, "tool_result");
        assertEquals(1, results.size());
        assertEquals("done B", results.get(0).get("content").getAsString());
    }

    // ---- zero usage / context window ----

    @Test
    public void zeroCountStepKeepsThePreviousStepUsageAndTheTurnTotal() throws Exception {
        writeSession(header(), user("go"),
                assistant("a1", usage(4, 6, 0, 0, 10, 0.5), "[{'type':'text','text':'first'}]"),
                assistant("a2", usage(0, 0, 0, 0, 0, 0.0), "[{'type':'text','text':'aborted'}]"));

        List<JsonObject> assistants = assistantEnvelopes(load());
        assertEquals(2, assistants.size());
        assertEquals(10, assistants.get(0).getAsJsonObject("message").getAsJsonObject("usage")
                .get("total_tokens").getAsLong());
        assertFalse(assistants.get(1).getAsJsonObject("message").has("usage"));
        JsonObject turn = assistants.get(1).getAsJsonObject("turnUsage");
        assertEquals(10, turn.get("total_tokens").getAsLong());
        assertEquals(0.5, assistants.get(1).get("turnCostUsd").getAsDouble(), 1e-9);
    }

    @Test
    public void usageWithoutTotalTokensIsTheSumOfTheCounts() {
        JsonObject raw = new JsonObject();
        raw.addProperty("input", 3);
        raw.addProperty("output", 4);
        raw.addProperty("cacheRead", 5);
        assertEquals(12, OmpHistoryUsage.fromOmpUsage(raw).get("total_tokens").getAsLong());
        assertNull(OmpHistoryUsage.fromOmpUsage(new JsonObject()));
    }

    @Test
    public void restoredUsageCarriesTheContextWindowOfKnownModelsOnly() throws Exception {
        JsonObject payload = json("{'success':true,'models':["
                + "{'id':'anthropic/claude-opus-5-5','contextWindow':1000000},"
                + "{'id':'kimi-code/k3','contextWindow':256000}]}");
        OmpContextWindows.update(payload);
        try {
            writeSession(header(), user("go"),
                    withModel(assistant("a1", usage(1, 2, 0, 0, 3, null), "[{'type':'text','text':'one'}]"),
                            "anthropic", "claude-opus-5-5"),
                    withModel(assistant("a2", usage(1, 2, 0, 0, 3, null), "[{'type':'text','text':'two'}]"),
                            "kimi-code", "k3"),
                    withModel(assistant("a3", usage(1, 2, 0, 0, 3, null), "[{'type':'text','text':'three'}]"),
                            "anthropic", "claude-unlisted"),
                    // A model id that already is a selector.
                    withModel(assistant("a4", usage(1, 2, 0, 0, 3, null), "[{'type':'text','text':'four'}]"),
                            "anthropic", "kimi-code/k3"));

            List<JsonObject> assistants = assistantEnvelopes(load());
            assertEquals(1_000_000, stepUsage(assistants.get(0)).get("model_context_window").getAsInt());
            assertEquals(256_000, stepUsage(assistants.get(1)).get("model_context_window").getAsInt());
            assertFalse(stepUsage(assistants.get(2)).has("model_context_window"));
            assertEquals(256_000, stepUsage(assistants.get(3)).get("model_context_window").getAsInt());
            assertFalse(assistants.get(3).getAsJsonObject("turnUsage").has("model_context_window"));
        } finally {
            OmpContextWindows.reset();
        }
    }

    @Test
    public void restoredUsageHasNoContextWindowWhileTheRegistryIsEmpty() throws Exception {
        OmpContextWindows.reset();
        writeSession(header(), user("go"),
                withModel(assistant("a1", usage(1, 2, 0, 0, 3, null), "[{'type':'text','text':'one'}]"),
                        "anthropic", "claude-opus-5-5"));
        assertFalse(stepUsage(assistantEnvelopes(load()).get(0)).has("model_context_window"));
    }

    // ---- WSL paths ----

    @Test
    public void writeWithoutResolvedPathUnderAPosixSessionDirectoryKeepsPosixSeparators() throws Exception {
        writeSession(header(), user("w"),
                assistant("a1", null, call("w1", "write", "{'path':'../other/./a.txt','content':'x'}")),
                toolResult("w1", "write", "Wrote", "{}", false));
        JsonObject use = blocks(load(), "tool_use").get(0);
        assertEquals("/work/other/a.txt", use.getAsJsonObject("input").get("file_path").getAsString());
    }

    // ---- helpers ----

    private List<JsonObject> load() throws Exception {
        List<JsonObject> messages = reader.getSessionMessages(SID, CWD);
        assertNotNull(messages);
        return messages;
    }

    /** Rewrites the provider and model recorded on an assistant entry line produced by {@link #assistant}. */
    private static String withModel(String assistantLine, String provider, String model) {
        JsonObject line = JsonParser.parseString(assistantLine).getAsJsonObject();
        JsonObject message = line.getAsJsonObject("message");
        message.addProperty("provider", provider);
        message.addProperty("model", model);
        return line.toString();
    }

    private static JsonObject stepUsage(JsonObject assistantEnvelope) {
        return assistantEnvelope.getAsJsonObject("message").getAsJsonObject("usage");
    }

    private String listedTitle() throws Exception {
        List<OmpHistoryReader.SessionInfo> listed = reader.listSessionsForProject(CWD);
        assertEquals(1, listed.size());
        return listed.get(0).title;
    }

    private void writeSession(String... lines) throws Exception {
        Path dir = root.resolve("-work-project");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("2026-08-09T14-55-02-653Z_" + SID + ".jsonl"),
                String.join("\n", lines) + "\n", StandardCharsets.UTF_8);
    }

    private static JsonObject json(String singleQuoted) {
        return JsonParser.parseString(singleQuoted.replace('\'', '"')).getAsJsonObject();
    }

    private static String titleSlot(String title) {
        JsonObject slot = new JsonObject();
        slot.addProperty("type", "title");
        slot.addProperty("v", 1);
        slot.addProperty("title", title);
        slot.addProperty("source", "auto");
        slot.addProperty("pad", "          ");
        return slot.toString();
    }

    private static String header() {
        JsonObject h = new JsonObject();
        h.addProperty("type", "session");
        h.addProperty("version", 3);
        h.addProperty("id", SID);
        h.addProperty("timestamp", "2026-08-09T14:55:02.653Z");
        h.addProperty("cwd", CWD);
        return h.toString();
    }

    private String user(String text) {
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        return entry(message);
    }

    /**
     * {@code contentJson} is a content array, or its blocks separated by commas, in single
     * quotes; usage may be null.
     */
    private String assistant(String id, JsonObject usage, String contentJson) {
        String blocks = contentJson.trim();
        String content = blocks.startsWith("[") ? blocks : "[" + blocks + "]";
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        message.add("content", JsonParser.parseString(content.replace('\'', '"')));
        message.addProperty("model", "claude-opus-5-5");
        if (usage != null) {
            message.add("usage", usage);
        }
        return entry(message);
    }

    private String toolResult(String callId, String toolName, String text, String detailsJson, boolean isError) {
        JsonObject message = new JsonObject();
        message.addProperty("role", "toolResult");
        message.addProperty("toolCallId", callId);
        message.addProperty("toolName", toolName);
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        message.add("details", JsonParser.parseString(detailsJson.replace('\'', '"')));
        message.addProperty("isError", isError);
        return entry(message);
    }

    private String entry(JsonObject message) {
        JsonObject e = new JsonObject();
        e.addProperty("type", "message");
        e.addProperty("id", "m" + (++entry));
        e.addProperty("timestamp", "2026-08-09T14:55:" + String.format("%02d", 10 + entry) + ".000Z");
        e.add("message", message);
        return e.toString();
    }

    private static String call(String id, String name, String argsSingleQuoted) {
        return "{'type':'toolCall','id':'" + id + "','name':'" + name + "','arguments':" + argsSingleQuoted + "}";
    }

    private static JsonObject usage(long input, long output, long cacheRead, long cacheWrite, long total,
                                    Double cost) {
        JsonObject usage = new JsonObject();
        usage.addProperty("input", input);
        usage.addProperty("output", output);
        usage.addProperty("cacheRead", cacheRead);
        usage.addProperty("cacheWrite", cacheWrite);
        usage.addProperty("totalTokens", total);
        if (cost != null) {
            JsonObject c = new JsonObject();
            c.addProperty("total", cost);
            usage.add("cost", c);
        }
        return usage;
    }

    private static List<JsonObject> assistantEnvelopes(List<JsonObject> messages) {
        List<JsonObject> out = new ArrayList<>();
        for (JsonObject m : messages) {
            if ("assistant".equals(m.get("type").getAsString())) {
                out.add(m);
            }
        }
        return out;
    }

    private static List<JsonObject> blocks(List<JsonObject> messages, String type) {
        List<JsonObject> out = new ArrayList<>();
        for (JsonObject m : messages) {
            for (JsonElement el : m.getAsJsonObject("message").getAsJsonArray("content")) {
                JsonObject block = el.getAsJsonObject();
                if (type.equals(block.get("type").getAsString())) {
                    out.add(block);
                }
            }
        }
        return out;
    }
}
