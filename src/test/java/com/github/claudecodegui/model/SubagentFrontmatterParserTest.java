package com.github.claudecodegui.model;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Behaviour tests for {@link SubagentFrontmatterParser} (task 57).
 *
 * <p>Two kinds of evidence are pinned here.
 *
 * <ol>
 *   <li><b>Contract cases</b> — the behaviours PRD R3 and R4 demand: missing
 *       frontmatter, an unterminated block, invalid YAML, a byte-order mark, an
 *       empty file, an oversized block, the two {@code tools} encodings, and
 *       unknown fields surviving a round trip. Every one of them asserts the
 *       documented outcome explicitly, so a behaviour change cannot slip in
 *       unnoticed.</li>
 *   <li><b>Real-world fixtures</b> — files copied verbatim from the developer's
 *       {@code ~/.claude/agents} directory (274 files, of which 122 carry no
 *       frontmatter at all and 39 carry frontmatter without a name). Those are
 *       the shapes the parser actually meets in the field; they are checked in
 *       under {@code src/test/resources} so the suite does not depend on the
 *       developer's home directory at run time.</li>
 * </ol>
 */
public class SubagentFrontmatterParserTest {

    private static final Path FIXTURES = Path.of("src/test/resources/agent-frontmatter-fixtures");

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    // ==================================================================
    // 1. Happy path — the whole specification field set survives
    // ==================================================================

    /**
     * A hand-written agent using every documented field must come back with all
     * of them, typed as the TypeScript model expects. This is the case that fails
     * first if a future field is added to {@link AgentFields#SPECIFICATION_FIELDS}
     * but not to the parser.
     */
    @Test
    public void shouldParseEverySpecificationField() throws Exception {
        Path file = write("full.md", """
                ---
                name: full-spec
                description: An agent that sets every documented field.
                tools:
                  - Read
                  - Grep
                disallowedTools: Bash, Write
                model: sonnet
                permissionMode: plan
                maxTurns: 12
                skills: [codebase-memory, commit]
                mcpServers: [codebase-memory-mcp]
                hooks:
                  PreToolUse:
                    - matcher: Bash
                      hooks:
                        - type: command
                          command: ./guard.sh
                memory: project
                background: true
                effort: high
                isolation: worktree
                color: blue
                initialPrompt: Start by reading the spec.
                omitClaudeMd: false
                experimental:
                  cacheTtl: 5m
                ---

                You are the system prompt. It is deliberately long so that the
                bounded-read assertions elsewhere in this class have something to
                over-read if the parser were to slurp the whole file.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertTrue(result.status().isLoadable());
        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertNull("a clean file must not carry a warning", result.warning());
        assertEquals("full-spec", result.name());

        JsonObject fields = result.fields();
        for (String field : AgentFields.SPECIFICATION_FIELDS) {
            assertTrue("specification field missing from result: " + field, fields.has(field));
        }

        assertEquals("sonnet", fields.get("model").getAsString());
        assertEquals("plan", fields.get("permissionMode").getAsString());
        assertEquals(12, fields.get("maxTurns").getAsInt());
        assertEquals("project", fields.get("memory").getAsString());
        assertTrue(fields.get("background").getAsBoolean());
        assertEquals("high", fields.get("effort").getAsString());
        assertEquals("worktree", fields.get("isolation").getAsString());
        assertEquals("blue", fields.get("color").getAsString());
        assertFalse(fields.get("omitClaudeMd").getAsBoolean());
        assertEquals("Start by reading the spec.", fields.get("initialPrompt").getAsString());
    }

    /**
     * The list-shaped fields must arrive as real JSON arrays, not as their string
     * renderings. {@code hooks} and {@code experimental} are objects; if either
     * were flattened to a string the UI could not render them (PRD R7).
     */
    @Test
    public void shouldReadComplexFieldsStructurally() throws Exception {
        Path file = write("complex.md", """
                ---
                name: complex
                description: Structurally heavy fields.
                tools: [Read, Grep, Glob]
                disallowedTools:
                  - Bash
                  - Write
                skills: [codebase-memory]
                mcpServers: [codebase-memory-mcp]
                hooks:
                  PreToolUse:
                    - matcher: Bash
                      hooks:
                        - type: command
                          command: ./guard.sh
                  PostToolUse:
                    - matcher: Edit
                      hooks:
                        - type: command
                          command: ./notify.sh
                experimental:
                  cacheTtl: 5m
                  nested:
                    flag: true
                ---

                Body.
                """);

        JsonObject fields = SubagentFrontmatterParser.parse(file).fields();

        assertEquals(JsonArray.class, fields.get("tools").getClass());
        assertEquals(3, fields.get("tools").getAsJsonArray().size());
        assertEquals(2, fields.get("disallowedTools").getAsJsonArray().size());
        assertEquals(1, fields.get("skills").getAsJsonArray().size());
        assertEquals(1, fields.get("mcpServers").getAsJsonArray().size());

        JsonObject hooks = fields.getAsJsonObject("hooks");
        assertEquals(2, hooks.size());
        assertTrue(hooks.getAsJsonArray("PreToolUse").get(0).getAsJsonObject()
                .has("matcher"));
        assertTrue(hooks.getAsJsonArray("PostToolUse").get(0).getAsJsonObject()
                .getAsJsonArray("hooks").get(0).getAsJsonObject().has("command"));

        JsonObject experimental = fields.getAsJsonObject("experimental");
        assertEquals("5m", experimental.get("cacheTtl").getAsString());
        assertTrue(experimental.getAsJsonObject("nested").get("flag").getAsBoolean());
    }

    // ==================================================================
    // 2. Malformed input — never an exception, always an explanation
    // ==================================================================

    /**
     * A file with no frontmatter at all is not an agent: the specification
     * requires {@code name} and {@code description}, and there is nothing to read.
     * 122 of the 274 real files are in exactly this state (they are reference
     * notes parked in the directory), so this must be a cheap, quiet verdict
     * rather than a crash or a phantom entry in the Agents tab.
     */
    @Test
    public void shouldReportMissingFrontmatterWithoutThrowing() throws Exception {
        Path file = write("no-frontmatter.md", """
                # Accessibility Patterns Reference

                ## ARIA Patterns for Common Components

                ### Modal Dialog

                Some prose that is not YAML and has no delimiters at all.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.NO_FRONTMATTER, result.status());
        assertFalse(result.status().isLoadable());
        assertNotNull("the caller must be able to explain the omission", result.warning());
        assertTrue(result.warning().contains("frontmatter"));
        assertEquals("the stem is still reported so the UI can name the file",
                "no-frontmatter", result.name());
    }

    /**
     * An empty file: no delimiter, no name, no throw. Callers must be able to tell
     * "nothing here" apart from a read failure only by the warning text, so it has
     * to be specific.
     */
    @Test
    public void shouldReportEmptyFile() throws Exception {
        Path file = write("empty.md", "");

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.NO_FRONTMATTER, result.status());
        assertFalse(result.status().isLoadable());
        assertNotNull(result.warning());
        // The stem is "empty" — a real agent name, so the warning has to name the
        // file rather than relying on an empty name to signal the problem.
        assertEquals("empty", result.name());
    }

    /**
     * An opening delimiter that is never closed. This is the dangerous shape: a
     * 300 KB markdown body full of horizontal rules looks identical. The parser
     * must therefore refuse rather than try to parse a fragment, and must not read
     * the whole file looking for the closer.
     */
    @Test
    public void shouldReportUnterminatedFrontmatter() throws Exception {
        Path file = write("unterminated.md", """
                ---
                name: unterminated
                description: The closing delimiter is missing.

                ## Body

                Some content.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.UNPARSEABLE, result.status());
        assertFalse(result.status().isLoadable());
        assertNotNull(result.warning());
        assertTrue(result.warning(), result.warning().contains("closing delimiter"));
    }

    /**
     * A well-delimited block whose YAML is broken. Same verdict as an
     * unterminated block: the block was intended, but nothing in it can be trusted.
     */
    @Test
    public void shouldReportInvalidYaml() throws Exception {
        Path file = write("bad-yaml.md", """
                ---
                name: bad-yaml
                description: The list below is not closed and the key is unquoted.
                tools: [Read, Grep
                model: "unterminated string
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.UNPARSEABLE, result.status());
        assertFalse(result.status().isLoadable());
        assertNotNull(result.warning());
        assertEquals("the raw name is still surfaced so nothing silently disappears",
                "bad-yaml", result.name());
    }

    /**
     * A block that is delimited but empty. Different from "no frontmatter": the
     * author clearly intended an agent, so the verdict is unparseable rather than
     * "not an agent", and the stem stands in for the missing name.
     */
    @Test
    public void shouldReportEmptyFrontmatterBlock() throws Exception {
        Path file = write("empty-block.md", """
                ---
                ---

                Body without any fields.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.UNPARSEABLE, result.status());
        assertFalse(result.status().isLoadable());
        assertNotNull(result.warning());
        assertEquals("empty-block", result.name());
    }

    /**
     * A block larger than the read budget. The parser must stop at the budget and
     * say so, rather than buffering a pathological file into the heap. Default
     * budget is 64 KiB; the largest real frontmatter measured is 2082 bytes
     * ({@code github-inbox.md}), so the default has a ~30x margin.
     */
    @Test
    public void shouldReportFrontmatterExceedingByteBudget() throws Exception {
        String huge = "x".repeat(40_000);
        Path file = write("huge-block.md", """
                ---
                name: huge
                description: %s
                ---

                Body.
                """.formatted(huge));

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file, 1024);

        assertEquals(SubagentFrontmatterParser.Status.UNPARSEABLE, result.status());
        assertFalse(result.status().isLoadable());
        assertNotNull(result.warning());
        assertTrue(result.warning(), result.warning().contains("1024"));
    }

    /**
     * A block whose region fits the budget is still parsed. The budget covers the
     * region scanned — the opening delimiter line, the YAML lines, and the closing
     * delimiter line — not the YAML text alone, so it is sized here from the actual
     * file rather than from a hand-counted number that would rot on the next edit.
     */
    @Test
    public void shouldAcceptBlockThatFitsTheByteBudget() throws Exception {
        String filler = "y".repeat(120);
        String content = """
                ---
                name: at-budget
                description: %s
                ---

                Body.
                """.formatted(filler);
        Path file = write("at-budget.md", content);

        // The region is everything up to and including the closing "---" line.
        int regionBytes = content.indexOf("\n---", 3) + "\n---".length() + 1;
        assertTrue(regionBytes < content.length());

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file, regionBytes);

        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertEquals("at-budget", result.name());
        // One byte less must be refused, which proves the budget is actually
        // binding rather than being ignored somewhere.
        SubagentFrontmatterParser.Result tight = SubagentFrontmatterParser.parse(file, regionBytes - 1);
        assertEquals(SubagentFrontmatterParser.Status.UNPARSEABLE, tight.status());
        assertTrue(tight.warning(), tight.warning().contains("read limit"));
    }

    // ==================================================================
    // 3. Frontmatter position and a byte-order mark
    // ==================================================================

    /**
     * A UTF-8 byte-order mark pushes {@code ---} out of position 0. Windows
     * editors add one silently, and a parser that insisted on position 0 would
     * silently drop those agents. Decision: the mark is skipped and a warning is
     * attached, but the file still loads.
     */
    @Test
    public void shouldSkipByteOrderMarkBeforeFrontmatter() throws Exception {
        String bom = String.valueOf((char) 0xFEFF);
        Path file = write("bom.md", bom + """
                ---
                name: bom-agent
                description: Starts after a byte-order mark.
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertTrue("a BOM must still yield a loadable agent", result.status().isLoadable());
        assertEquals("bom-agent", result.name());
        assertNotNull("the author should be told the file has a BOM",
                result.warning());
        assertTrue(result.warning(), result.warning().toLowerCase().contains("byte-order"));
    }

    /**
     * Frontmatter that is <em>not</em> at the start of the file is a refusal, not
     * a warning: unlike a BOM, a leading blank line or a stray prose line is
     * ambiguous, and guessing where the metadata starts would mean scanning an
     * arbitrarily long markdown body. This is the one rule carried over unchanged
     * from {@code SkillFrontmatterParser}.
     */
    @Test
    public void shouldRefuseFrontmatterNotAtStartOfFile() throws Exception {
        Path file = write("leading-blank.md", """

                ---
                name: offset
                description: The block starts on the second line.
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.NO_FRONTMATTER, result.status());
        assertFalse(result.status().isLoadable());
        assertNotNull(result.warning());
    }

    // ==================================================================
    // 4. tools: list, comma-separated string, and JSON array literal
    // ==================================================================

    /**
     * Real agents in the field use three encodings for {@code tools}. The YAML
     * block-list form, seen in {@code codebase-memory-auditor.md}.
     */
    @Test
    public void shouldReadToolsAsYamlList() throws Exception {
        Path file = write("tools-list.md", """
                ---
                name: tools-list
                description: Block list form.
                tools:
                  - Read
                  - Grep
                  - mcp__codebase-memory-mcp__search_graph
                ---

                Body.
                """);

        JsonArray tools = SubagentFrontmatterParser.parse(file).fields().getAsJsonArray("tools");

        assertEquals(3, tools.size());
        assertEquals("Read", tools.get(0).getAsString());
        assertEquals("mcp__codebase-memory-mcp__search_graph", tools.get(2).getAsString());
    }

    /**
     * The comma-separated string form, seen in {@code team-implementer.md} and
     * {@code conductor-validator.md}. Blank segments from a trailing comma are
     * dropped, and {@code disallowedTools} uses the same encoding.
     */
    @Test
    public void shouldReadToolsAsCommaSeparatedString() throws Exception {
        Path file = write("tools-csv.md", """
                ---
                name: tools-csv
                description: Comma separated form.
                tools: Read, Write, Edit, Glob, Grep, Bash
                disallowedTools: WebSearch, ,
                ---

                Body.
                """);

        JsonObject fields = SubagentFrontmatterParser.parse(file).fields();

        JsonArray tools = fields.getAsJsonArray("tools");
        assertEquals(6, tools.size());
        assertEquals("Bash", tools.get(5).getAsString());

        JsonArray disallowed = fields.getAsJsonArray("disallowedTools");
        // The fixture deliberately carries a trailing ", ," so the empty segment
        // is dropped rather than becoming an empty tool name.
        assertEquals(1, disallowed.size());
        assertEquals("WebSearch", disallowed.get(0).getAsString());
    }

    /**
     * The JSON array literal form, seen in {@code github-inbox.md}
     * ({@code tools: ["Bash", "Read", "Write"]}). YAML parses this as a real list
     * because a flow sequence is legal YAML; the test pins that it is not
     * mistakenly treated as a comma-separated string.
     */
    @Test
    public void shouldReadToolsAsJsonArrayLiteral() throws Exception {
        Path file = write("tools-flow.md", """
                ---
                name: tools-flow
                description: Flow sequence form.
                tools: ["Bash", "Read", "Write"]
                ---

                Body.
                """);

        JsonArray tools = SubagentFrontmatterParser.parse(file).fields().getAsJsonArray("tools");

        assertEquals(3, tools.size());
        assertEquals("Bash", tools.get(0).getAsString());
    }

    /**
     * {@code tools: []} means "no tools" and is a real value, not an absent one.
     * It must survive as an empty array so the UI can tell the two apart — an
     * omitted {@code tools} inherits everything, an empty one inherits nothing.
     */
    @Test
    public void shouldPreserveEmptyToolsList() throws Exception {
        Path file = write("tools-empty.md", """
                ---
                name: tools-empty
                description: Explicitly no tools.
                tools: []
                ---

                Body.
                """);

        JsonObject fields = SubagentFrontmatterParser.parse(file).fields();

        assertTrue(fields.has("tools"));
        assertEquals(0, fields.getAsJsonArray("tools").size());
    }

    // ==================================================================
    // 5. Unknown fields are preserved, not fatal
    // ==================================================================

    /**
     * The specification will grow. A key this parser has never heard of must be
     * carried through untouched so a newer Claude Code does not lose data on a
     * read/write round trip, and must not stop the recognised fields from loading.
     * The real files carry several such keys: {@code argument-hint},
     * {@code allowed-tools}, {@code version}, {@code tags}, {@code globs},
     * {@code keywords}, {@code tool_access}.
     */
    @Test
    public void shouldPreserveUnknownFieldsWithoutFailing() throws Exception {
        Path file = write("unknown.md", """
                ---
                name: unknown-fields
                description: Carries keys the parser does not model.
                model: haiku
                argument-hint: <file>
                allowed-tools: Read, Grep
                version: 1.0.0
                tags: [audit, security]
                futureField:
                  nested: 42
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertTrue(result.status().isLoadable());
        assertNull("an unknown key is not a problem worth warning about", result.warning());

        JsonObject fields = result.fields();
        assertEquals("haiku", fields.get("model").getAsString());
        assertEquals("<file>", fields.get("argument-hint").getAsString());
        assertEquals("Read, Grep", fields.get("allowed-tools").getAsString());
        assertEquals("1.0.0", fields.get("version").getAsString());
        assertEquals(2, fields.getAsJsonArray("tags").size());
        assertEquals(42, fields.getAsJsonObject("futureField").get("nested").getAsInt());
    }

    // ==================================================================
    // 6. Name rules
    // ==================================================================

    /**
     * 39 of the 152 real files that have frontmatter have no {@code name} at all.
     * Dropping them would be exactly the silent loss PRD R4 forbids, so the file
     * stem stands in and the substitution is announced.
     */
    @Test
    public void shouldFallBackToFileStemWhenNameMissing() throws Exception {
        Path file = write("no-name-field.md", """
                ---
                description: Frontmatter without a name key.
                model: sonnet
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertTrue(result.status().isLoadable());
        assertEquals("no-name-field", result.name());
        assertNotNull(result.warning());
        assertTrue(result.warning(), result.warning().contains("no-name-field"));
    }

    /**
     * Task 56's decision, honoured here: a non-hyphen-case name is a non-blocking
     * warning, never a rejection. The specification documents no such constraint,
     * and real stores contain names like "New Agent".
     */
    @Test
    public void shouldWarnButLoadOnNonHyphenCaseName() throws Exception {
        Path file = write("spacey.md", """
                ---
                name: New Agent
                description: A name with spaces, which is legal.
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertTrue("a non-hyphen-case name must not block loading", result.status().isLoadable());
        assertEquals("New Agent", result.name());
        assertTrue(AgentFields.isNonHyphenCaseName(result.name()));
        assertNotNull(result.warning());
        assertTrue(result.warning(), result.warning().contains("hyphen"));
    }

    /**
     * A name carrying {@code ':'} is the one character the specification actually
     * forbids, because it is reserved for plugin-scoped identifiers. Here
     * {@link AgentFields#isValidName} does the deciding and the parser refuses.
     * The raw name is still reported so the entry is visible, not vanished.
     */
    @Test
    public void shouldRefuseNameWithReservedColon() throws Exception {
        Path file = write("colon.md", """
                ---
                name: "my-plugin:reviewer"
                description: Colon is reserved for plugin-scoped ids.
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertFalse(result.status().isLoadable());
        assertEquals(SubagentFrontmatterParser.Status.UNPARSEABLE, result.status());
        assertNotNull(result.warning());
        assertTrue(result.warning(), result.warning().contains("my-plugin:reviewer"));
        // The offending name is still surfaced rather than replaced by the stem.
        assertEquals("my-plugin:reviewer", result.name());
        assertFalse(AgentFields.isValidName(result.name()));
    }

    // ==================================================================
    // 7. Bounded reading — the body is never slurped
    // ==================================================================

    /**
     * The load-bearing performance contract (PRD R2): the parser stops the instant
     * the closing delimiter is seen. A counting stream makes the claim exact —
     * it proves bytes <em>past</em> the block are never requested, not merely that
     * the test happened to be fast.
     */
    @Test
    public void shouldNotReadPastTheClosingDelimiter() throws Exception {
        String frontmatter = "---\nname: bounded\ndescription: Stops here.\n---\n";
        String body = "System prompt. ".repeat(500_000); // ~8 MB, like a fat agent file
        byte[] all = (frontmatter + body).getBytes(StandardCharsets.UTF_8);

        CountingStream counter = new CountingStream(all);
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                counter, "bounded.md", SubagentFrontmatterParser.DEFAULT_MAX_FRONTMATTER_BYTES);

        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertEquals("bounded", result.name());
        assertTrue("read " + counter.read + " bytes for a " + all.length + " byte file",
                counter.read <= frontmatter.length() + 1);
    }

    /**
     * The same guarantee against a real file on disk, with a wall-clock bound so a
     * regression that slurps the body fails the build instead of merely getting
     * slower. 8 MB of body against a 4 KiB budget.
     */
    @Test(timeout = 15_000)
    public void shouldParseFileWithHugeBodyQuickly() throws Exception {
        String body = "System prompt line. ".repeat(400_000); // ~8 MB
        Path file = write("huge-body.md", """
                ---
                name: huge-body
                description: The body below is enormous.
                ---

                """ + body);

        assertTrue("fixture should really be large", Files.size(file) > 5_000_000);

        long start = System.nanoTime();
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file, 4096);
        long elapsedMillis = (System.nanoTime() - start) / 1_000_000;

        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertEquals("huge-body", result.name());
        assertTrue("parsing took " + elapsedMillis + " ms", elapsedMillis < 2000);
    }

    /**
     * Windows line endings must not break delimiter detection: the block is
     * delimited by CRLF too, and the YAML parser normalises the content.
     */
    @Test
    public void shouldHandleCarriageReturnLineEndings() throws Exception {
        Path file = write("crlf.md",
                "---\r\nname: crlf\r\ndescription: Windows line endings.\r\n---\r\n\r\nBody.\r\n");

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertEquals("crlf", result.name());
        assertEquals("Windows line endings.", result.fields().get("description").getAsString());
    }

    /**
     * A delimiter must own its line. The skill parser looks for {@code "\n---"}
     * without checking what follows, so a value line such as {@code key: ---x}
     * or a markdown rule with trailing characters can end the block early. Requiring
     * the line to be exactly the delimiter fixes that class of bug.
     */
    @Test
    public void shouldNotTreatDashesWithTrailingTextAsADelimiter() throws Exception {
        Path file = write("dashes.md", """
                ---
                name: dashes
                description: Contains --- not on its own line.
                ---
                model: sonnet
                ---

                Body.
                """);

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertEquals("dashes", result.name());
    }

    // ==================================================================
    // 8. Real-world fixtures
    // ==================================================================

    /**
     * {@code java-pro.md} copied verbatim: the archetypal agent, three scalar
     * fields and a 7 KB system prompt.
     */
    @Test
    public void shouldParseRealJavaProFixture() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                fixture("java-pro.md"));

        assertTrue(result.warning(), result.status().isLoadable());
        assertNull(result.warning());
        assertEquals("java-pro", result.name());
        assertEquals("sonnet", result.fields().get("model").getAsString());
        assertTrue(result.fields().get("description").getAsString().startsWith("Master Java 21+"));
    }

    /**
     * {@code codebase-memory-auditor.md} copied verbatim: a 13-entry block-list
     * {@code tools}, a flow-sequence {@code mcpServers} and {@code skills}, and a
     * scalar {@code permissionMode} — the most structurally varied real agent.
     */
    @Test
    public void shouldParseRealCodebaseMemoryAuditorFixture() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                fixture("codebase-memory-auditor.md"));

        assertTrue(result.warning(), result.status().isLoadable());
        assertNull(result.warning());
        assertEquals("codebase-memory-auditor", result.name());

        JsonObject fields = result.fields();
        JsonArray tools = fields.getAsJsonArray("tools");
        assertEquals(14, tools.size());
        assertEquals("Read", tools.get(0).getAsString());
        assertEquals("mcp__codebase-memory-mcp__check_index_coverage",
                tools.get(13).getAsString());
        assertEquals(1, fields.getAsJsonArray("mcpServers").size());
        assertEquals("codebase-memory-mcp", fields.getAsJsonArray("mcpServers").get(0).getAsString());
        assertEquals(1, fields.getAsJsonArray("skills").size());
        assertEquals("plan", fields.get("permissionMode").getAsString());
    }

    /**
     * {@code team-implementer.md} copied verbatim: the comma-separated
     * {@code tools} encoding plus a {@code color}.
     */
    @Test
    public void shouldParseRealTeamImplementerFixture() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                fixture("team-implementer.md"));

        assertTrue(result.warning(), result.status().isLoadable());
        assertEquals("team-implementer", result.name());

        JsonArray tools = result.fields().getAsJsonArray("tools");
        assertEquals(6, tools.size());
        assertEquals("Read", tools.get(0).getAsString());
        assertEquals("Bash", tools.get(5).getAsString());
        assertEquals("yellow", result.fields().get("color").getAsString());
    }

    /**
     * {@code ai-assistant.md} copied verbatim: one of the 39 real files whose
     * frontmatter has no {@code name} at all. The stem stands in and the
     * substitution is announced, rather than the entry being dropped.
     */
    @Test
    public void shouldParseRealAiAssistantFixtureFallingBackToStem() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                fixture("ai-assistant.md"));

        assertTrue(result.status().isLoadable());
        assertEquals("ai-assistant", result.name());
        assertNotNull("a substituted name must be announced", result.warning());
        // The skill/command-only keys come through untouched.
        assertEquals("<assistant-type> [options]",
                result.fields().get("argument-hint").getAsString());
    }

    /**
     * {@code arm-cortex-expert.md} copied verbatim: carries {@code tools: []} and a
     * YAML folded block scalar ({@code description: >}) whose value spans several
     * lines. Both must survive — an empty tool list is a real value, and the folded
     * scalar must arrive as one collapsed string rather than a list of lines.
     */
    @Test
    public void shouldParseRealArmCortexExpertFixtureWithEmptyToolsAndFoldedScalar() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                fixture("arm-cortex-expert.md"));

        assertTrue(result.warning(), result.status().isLoadable());
        assertEquals("arm-cortex-expert", result.name());

        JsonObject fields = result.fields();
        assertTrue("an explicit empty tool list is a value, not an absence", fields.has("tools"));
        assertEquals(0, fields.getAsJsonArray("tools").size());
        assertTrue(fields.get("description").getAsString().startsWith("Senior embedded software"));
        // A folded scalar collapses its line breaks into spaces. YAML may still keep a
        // single trailing newline on the value, so only interior newlines are
        // evidence that the block was not folded.
        assertFalse("a folded scalar must collapse its line breaks",
                fields.get("description").getAsString().replaceAll("\\s+$", "").contains("\n"));
        assertEquals("sonnet", fields.get("model").getAsString());
    }

    /**
     * {@code github-inbox.md} copied verbatim: the largest frontmatter measured in
     * the field at 2082 bytes, and the JSON-array-literal {@code tools} form.
     */
    @Test
    public void shouldParseRealGithubInboxFixture() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                fixture("github-inbox.md"));

        assertTrue(result.warning(), result.status().isLoadable());
        assertEquals("github-inbox", result.name());
        assertEquals(3, result.fields().getAsJsonArray("tools").size());
    }

    /**
     * Decision, stated as a test: {@code README.md} is not an agent.
     *
     * <p>It sits in {@code ~/.claude/agents} but carries no frontmatter, so there
     * is no {@code name} and no {@code description} — the two fields the
     * specification requires. Claude Code itself ignores such files, and so does
     * the parser: it reports {@link SubagentFrontmatterParser.Status#NO_FRONTMATTER}
     * and does not fabricate an agent out of a documentation page. The warning
     * exists so the scanner can log or surface the skip.
     */
    @Test
    public void shouldNotTreatReadmeAsAgent() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(
                fixture("README.md"));

        assertEquals(SubagentFrontmatterParser.Status.NO_FRONTMATTER, result.status());
        assertFalse("a README must not become a phantom agent", result.status().isLoadable());
        assertNotNull(result.warning());
        assertTrue(result.fields().isEmpty());
    }

    /**
     * Decision, stated as a test: {@code SKILL.md} is not an agent either, even
     * though it <em>does</em> have frontmatter. Its name is {@code workflow-patterns},
     * which would collide with the real {@code workflow-patterns.md} sitting beside
     * it and make two different things fight over one name. The spec distinguishes
     * the two file kinds by name, and the specification field set does not fit —
     * this file carries {@code version}, a skill-only key.
     *
     * <p>So the parser is deliberately format-driven, not filename-driven: it
     * reports what the block says and leaves the "is this file an agent" question
     * to the scanner, which applies the {@code *.md}-is-an-agent rule with
     * reserved-name filtering. What the parser guarantees — and what this test
     * pins — is that it never throws on a foreign file and never crashes the scan.
     */
    @Test
    public void shouldParseForeignSkillFileWithoutThrowingAndNotClaimItIsAnAgent() {
        Path skill = fixture("SKILL.md");

        // A missing fixture must not silently turn this into a vacuous test.
        assertTrue("fixture missing: " + skill, Files.isRegularFile(skill));

        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(skill);

        // The block itself is well formed, so the parser reports what it says...
        assertEquals(SubagentFrontmatterParser.Status.PARSED, result.status());
        assertEquals("workflow-patterns", result.name());
        // ...and the skill-only key is preserved rather than dropped, because a
        // future version may want to surface it.
        assertEquals("1.0.0", result.fields().get("version").getAsString());

        // The scanner-side rule that keeps it out of the Agents tab is recorded
        // here as an executable statement of the decision: the reserved name
        // SKILL.md never yields an agent.
        assertTrue("SKILL.md is a reserved filename, never an agent",
                SubagentFrontmatterParser.isReservedNonAgentFilename("SKILL.md"));
        assertTrue(SubagentFrontmatterParser.isReservedNonAgentFilename("README.md"));
        assertTrue(SubagentFrontmatterParser.isReservedNonAgentFilename("skill.md"));
        assertTrue(SubagentFrontmatterParser.isReservedNonAgentFilename("readme.md"));
        assertTrue(SubagentFrontmatterParser.isReservedNonAgentFilename("CLAUDE.md"));
        assertFalse(SubagentFrontmatterParser.isReservedNonAgentFilename("java-pro.md"));
    }

    /**
     * Every checked-in fixture must be classified deterministically, and the whole
     * set must be parseable without an exception. This is the regression net for
     * the sweep over a developer's real directory.
     */
    @Test
    public void shouldClassifyEveryFixtureWithoutThrowing() throws Exception {
        List<Path> fixtures = new ArrayList<>();
        try (var stream = Files.list(FIXTURES)) {
            stream.filter(p -> p.getFileName().toString().endsWith(".md")).forEach(fixtures::add);
        }
        assertTrue("no fixtures found under " + FIXTURES, fixtures.size() >= 8);

        for (Path fixture : fixtures) {
            SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(fixture);
            assertNotNull("no result for " + fixture, result);
            assertNotNull("no status for " + fixture, result.status());
            assertNotNull("no name for " + fixture, result.name());
            assertNotNull("no fields for " + fixture, result.fields());
            // Every non-loadable fixture must explain itself, or the UI would
            // show a gap with no cause (PRD AC3).
            if (!result.status().isLoadable()) {
                assertNotNull("unexplained skip: " + fixture, result.warning());
            }
        }
    }

    /**
     * The parser's central promise: no input, however broken, produces a thrown
     * exception. Discovery runs over hundreds of files on a background path; one
     * bad file must not abort the scan.
     */
    @Test
    public void shouldNeverThrowOnArbitraryInput() throws Exception {
        List<byte[]> inputs = List.of(
                new byte[0],
                "---".getBytes(StandardCharsets.UTF_8),
                "---\n---".getBytes(StandardCharsets.UTF_8),
                "---\n\t: : :\n---".getBytes(StandardCharsets.UTF_8),
                "--".getBytes(StandardCharsets.UTF_8),
                "---\nname: \n---".getBytes(StandardCharsets.UTF_8),
                "---\nname: [unclosed\n---".getBytes(StandardCharsets.UTF_8),
                ("---\n" + "name: x\n".repeat(5000) + "---").getBytes(StandardCharsets.UTF_8),
                new byte[]{(byte) 0xFF, (byte) 0xFE, (byte) 0x00, (byte) 0x01},
                "\u0000\u0000\u0000".getBytes(StandardCharsets.UTF_8)
        );

        for (int i = 0; i < inputs.size(); i++) {
            Path file = temp.newFile("fuzz-" + i + ".md").toPath();
            Files.write(file, inputs.get(i));
            SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse(file);
            assertNotNull("input " + i + " produced no result", result);
            assertNotNull("input " + i + " produced no status", result.status());
        }

        // A path that does not exist, and a directory, are I/O errors rather than
        // parse errors; both must still come back as a result.
        SubagentFrontmatterParser.Result missing =
                SubagentFrontmatterParser.parse(temp.getRoot().toPath().resolve("nope.md"));
        assertFalse(missing.status().isLoadable());
        assertNotNull(missing.warning());

        SubagentFrontmatterParser.Result directory = SubagentFrontmatterParser.parse(temp.getRoot().toPath());
        assertFalse(directory.status().isLoadable());
        assertNotNull(directory.warning());
    }

    /**
     * A null or blank path is a programming error at the call site, but a
     * discovery sweep should still not be able to blow up on one.
     */
    @Test
    public void shouldHandleNullPathWithoutThrowing() {
        SubagentFrontmatterParser.Result result = SubagentFrontmatterParser.parse((Path) null);

        assertFalse(result.status().isLoadable());
        assertNotNull(result.warning());
        assertNotNull(result.fields());
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    // ==================================================================
    // Locating the problem in the file
    // ==================================================================

    /**
     * The point of the line number is that clicking it lands on the mistake.
     * snakeyaml counts from 0 within the block it was handed, and the block
     * starts on file line 2 because the opening --- is line 1, so the two
     * differ by exactly 2. Pinned here on three unrelated failure shapes,
     * because getting this wrong silently sends the user one line off in a
     * file they are trying to fix.
     */
    @Test
    public void aDuplicateKeyIsReportedOnItsOwnLine() throws IOException {
        Path file = write("dup.md", String.join("\n",
                "---",            // line 1
                "name: a",        // line 2
                "name: b",        // line 3  <- the duplicate
                "tools: [Read]",  // line 4
                "---",
                "body"));

        var result = SubagentFrontmatterParser.parse(file);

        assertFalse(result.fields().has("name") && "a".equals(result.fields().get("name").getAsString())
                && result.isLoadable());
        assertEquals("must point at the second `name`, not the block",
                Integer.valueOf(3), result.warningLine());
    }

    @Test
    public void aBadIndentationIsReportedOnItsOwnLine() throws IOException {
        Path file = write("indent.md", String.join("\n",
                "---",                  // line 1
                "name: x",              // line 2
                "description: fine",    // line 3
                "  bad: indent",        // line 4  <- the problem
                "model: y",             // line 5
                "---",
                "body"));

        var result = SubagentFrontmatterParser.parse(file);

        assertEquals(Integer.valueOf(4), result.warningLine());
    }

    /**
     * An unterminated block has no YAML error to point at, so the line is where
     * reading stopped -- the line where the closing --- was due.
     */
    @Test
    public void anUnterminatedBlockPointsAtWhereTheFenceWasDue() throws IOException {
        Path file = write("noclose.md", String.join("\n",
                "---",              // line 1
                "name: y",          // line 2
                "description: hi",  // line 3
                "model: sonnet",    // line 4
                "this is the body", // line 5  <- where --- should have been
                ""));

        var result = SubagentFrontmatterParser.parse(file);

        assertEquals(SubagentFrontmatterParser.Status.UNPARSEABLE, result.status());
        assertEquals(Integer.valueOf(5), result.warningLine());
    }

    /**
     * Not every warning has a location, and inventing one would be worse than
     * omitting it: a link to line 4 of a file whose problem is that line 2 has
     * no name sends the user somewhere irrelevant.
     */
    @Test
    public void aWarningWithNoSingleLocationCarriesNoLine() throws IOException {
        Path file = write("noname.md", String.join("\n",
                "---",
                "description: this agent never declares a name",
                "tools: [Read]",
                "---",
                "body"));

        var result = SubagentFrontmatterParser.parse(file);

        assertNotNull(result.warning());
        assertNull("a nameless agent has no line to blame", result.warningLine());
    }

    /** A healthy file must not invent a problem location. */
    @Test
    public void aValidAgentCarriesNoWarningLine() throws IOException {
        Path file = write("good.md", String.join("\n",
                "---",
                "name: good",
                "description: fine",
                "---",
                "body"));

        var result = SubagentFrontmatterParser.parse(file);

        assertTrue(result.isLoadable());
        assertNull(result.warningLine());
    }

    private Path write(String name, String content) throws IOException {
        Path file = temp.newFile(name).toPath();
        Files.write(file, content.getBytes(StandardCharsets.UTF_8));
        return file;
    }

    private static Path fixture(String name) {
        Path path = FIXTURES.resolve(name);
        assertTrue("fixture missing: " + path, Files.isRegularFile(path));
        return path;
    }

    /**
     * An {@link InputStream} that counts how many bytes were actually pulled, so a
     * test can assert on read volume rather than on wall-clock timing alone.
     */
    private static final class CountingStream extends InputStream {
        private final InputStream delegate;
        private long read;

        CountingStream(byte[] bytes) {
            this.delegate = new ByteArrayInputStream(bytes);
        }

        @Override
        public int read() throws IOException {
            int b = delegate.read();
            if (b >= 0) {
                read++;
            }
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = delegate.read(b, off, len);
            if (n > 0) {
                read += n;
            }
            return n;
        }

        @Override
        public int available() throws IOException {
            return delegate.available();
        }

        @Override
        public void close() throws IOException {
            delegate.close();
        }
    }

    /**
     * Unused-import guard: these references keep the gson types the assertions
     * rely on explicit even if an assertion is later refactored away.
     */
    @SuppressWarnings("unused")
    private static void gsonTypesInUse(JsonElement element, JsonPrimitive primitive) {
        assertNotNull(element);
        assertNotNull(primitive);
    }
}
